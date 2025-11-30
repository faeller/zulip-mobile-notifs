// crypto utilities for credential encryption
// uses AES-256-GCM with per-user keys derived from master secret + userId

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// derive a per-user encryption key from master secret + userId
async function deriveKey(masterSecret: string, userId: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterSecret),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  )

  // use userId as part of salt for per-user key derivation
  const salt = encoder.encode(`zulip-pusher-v1:${userId}`)

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// encrypt credentials (email + apiKey) for storage
export async function encryptCredentials(
  masterSecret: string,
  userId: string,
  email: string,
  apiKey: string
): Promise<string> {
  const key = await deriveKey(masterSecret, userId)
  const data = JSON.stringify({ email, apiKey })

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  )

  // combine iv + ciphertext
  const combined = new Uint8Array(iv.length + encrypted.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(encrypted), iv.length)

  // base64 encode
  return btoa(String.fromCharCode(...combined))
}

// decrypt credentials from storage
export async function decryptCredentials(
  masterSecret: string,
  userId: string,
  encryptedData: string
): Promise<{ email: string; apiKey: string }> {
  const key = await deriveKey(masterSecret, userId)

  // base64 decode
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))

  // split iv and ciphertext
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )

  const data = JSON.parse(decoder.decode(decrypted))
  return { email: data.email, apiKey: data.apiKey }
}
