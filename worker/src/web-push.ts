// web-push.ts - Web Push using aesgcm encoding (older but widely supported)
// based on cf-webpush implementation, uses only Web Crypto API

const encoder = new TextEncoder()

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlDecode(str: string): Uint8Array {
  const pad = '='.repeat((4 - str.length % 4) % 4)
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((a, b) => a + b.length, 0)
  const result = new Uint8Array(len)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

// create VAPID JWT
async function createJwt(
  privateKeyB64: string,
  publicKeyB64: string,
  audience: string,
  subject: string
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject
  }

  const headerB64 = b64url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)))
  const unsigned = `${headerB64}.${payloadB64}`

  // import private key
  const publicKey = b64urlDecode(publicKeyB64)
  const privateKey = b64urlDecode(privateKeyB64)

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(publicKey.slice(1, 33)),
    y: b64url(publicKey.slice(33, 65)),
    d: b64url(privateKey)
  }

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  )

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned)
  )

  return `${unsigned}.${b64url(sig)}`
}

// encrypt payload using aesgcm encoding
async function encryptPayload(
  payload: string,
  clientP256dh: string,
  clientAuth: string
): Promise<{ body: ArrayBuffer; salt: string; localPublicKey: string }> {
  // decode client keys
  const authSecret = b64urlDecode(clientAuth)
  const clientPublicKeyBytes = b64urlDecode(clientP256dh)

  // import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(clientPublicKeyBytes.slice(1, 33)),
      y: b64url(clientPublicKeyBytes.slice(33, 65)),
      ext: true
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true, []
  )

  // generate ephemeral keypair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits']
  )

  // derive shared secret
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    localKeyPair.privateKey,
    256
  )

  const sharedSecret = await crypto.subtle.importKey(
    'raw', sharedSecretBits,
    { name: 'HKDF' },
    false, ['deriveBits']
  )

  // derive PRK (pseudo-random key) using auth secret
  const prkBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: authSecret,
      info: encoder.encode('Content-Encoding: auth\0')
    },
    sharedSecret,
    256
  )

  const prk = await crypto.subtle.importKey(
    'raw', prkBits,
    { name: 'HKDF' },
    false, ['deriveBits']
  )

  // create context for CEK/nonce derivation
  const [clientPubBytes, localPubBytes] = await Promise.all([
    crypto.subtle.exportKey('raw', clientPublicKey),
    crypto.subtle.exportKey('raw', localKeyPair.publicKey)
  ]) as [ArrayBuffer, ArrayBuffer]

  const context = concat(
    encoder.encode('P-256\0'),
    new Uint8Array([0, clientPubBytes.byteLength]),
    new Uint8Array(clientPubBytes),
    new Uint8Array([0, localPubBytes.byteLength]),
    new Uint8Array(localPubBytes)
  )

  // generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16))

  // derive nonce (12 bytes)
  const nonceInfo = concat(encoder.encode('Content-Encoding: nonce\0'), context)
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
    prk,
    12 * 8
  )

  // derive CEK (16 bytes)
  const cekInfo = concat(encoder.encode('Content-Encoding: aesgcm\0'), context)
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo },
    prk,
    16 * 8
  )

  const cek = await crypto.subtle.importKey(
    'raw', cekBits,
    { name: 'AES-GCM' },
    false, ['encrypt']
  )

  // add padding (2 bytes length + random padding)
  const payloadBytes = encoder.encode(payload)
  const paddingSize = Math.min(Math.round(Math.random() * 16), 4078 - payloadBytes.length - 2)
  const padded = new Uint8Array(2 + paddingSize + payloadBytes.length)
  new DataView(padded.buffer).setUint16(0, paddingSize)
  padded.set(payloadBytes, 2 + paddingSize)

  // encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cek,
    padded
  )

  return {
    body: encrypted,
    salt: b64url(salt),
    localPublicKey: b64url(localPubBytes)
  }
}

// send web push notification
export async function sendWebPush(
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<Response> {
  const url = new URL(endpoint)
  const audience = `${url.protocol}//${url.host}`

  const jwt = await createJwt(vapidPrivateKey, vapidPublicKey, audience, vapidSubject)
  const { body, salt, localPublicKey } = await encryptPayload(payload, p256dh, auth)

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
      'Encryption': `salt=${salt}`,
      'Crypto-Key': `dh=${localPublicKey}`,
      'Content-Encoding': 'aesgcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.byteLength.toString(),
      'TTL': '86400'
    },
    body
  })
}
