import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { App as CapApp } from '@capacitor/app'
import type { ZulipCredentials } from './types'

const API_KEY_LENGTH = 32
const OTP_LENGTH = API_KEY_LENGTH * 2 // 64 hex chars

// generate random OTP (64 hex characters)
function generateOtp(): string {
  const bytes = new Uint8Array(API_KEY_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}


// convert hex to ascii string
function hexToAscii(hex: string): string {
  let result = ''
  for (let i = 0; i < hex.length; i += 2) {
    result += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  }
  return result
}

// xor two hex strings
function xorHexStrings(a: string, b: string): string {
  let result = ''
  for (let i = 0; i < a.length; i += 2) {
    const byteA = parseInt(a.substr(i, 2), 16)
    const byteB = parseInt(b.substr(i, 2), 16)
    result += (byteA ^ byteB).toString(16).padStart(2, '0')
  }
  return result
}

// decrypt the otp-encrypted api key
function decryptApiKey(encryptedKey: string, otp: string): string {
  if (encryptedKey.length !== OTP_LENGTH || otp.length !== OTP_LENGTH) {
    throw new Error('Invalid key or OTP length')
  }
  const hexKey = xorHexStrings(encryptedKey, otp)
  return hexToAscii(hexKey)
}

// parse zulip:// callback url
function parseZulipCallback(url: string): { email: string; apiKey: string; realm: string } | null {
  try {
    // url format: zulip://login?otp_encrypted_api_key=...&email=...&realm=...&user_id=...
    const urlObj = new URL(url)
    const params = urlObj.searchParams

    const encryptedKey = params.get('otp_encrypted_api_key')
    const email = params.get('email')
    const realm = params.get('realm')

    if (!encryptedKey || !email || !realm) {
      console.error('[sso] missing params in callback:', { encryptedKey: !!encryptedKey, email: !!email, realm: !!realm })
      return null
    }

    return { email, apiKey: encryptedKey, realm }
  } catch (err) {
    console.error('[sso] failed to parse callback url:', err)
    return null
  }
}

// stored otp for decryption after callback
let pendingOtp: string | null = null
let pendingResolve: ((creds: ZulipCredentials | null) => void) | null = null

// handle the zulip:// deep link callback
export function handleSsoCallback(url: string): boolean {
  if (!url.startsWith('zulip://')) return false

  console.log('[sso] received callback:', url)

  const parsed = parseZulipCallback(url)
  if (!parsed || !pendingOtp) {
    console.error('[sso] invalid callback or no pending otp')
    pendingResolve?.(null)
    pendingOtp = null
    pendingResolve = null
    return true
  }

  try {
    const apiKey = decryptApiKey(parsed.apiKey, pendingOtp)
    console.log('[sso] decrypted api key successfully')

    const creds: ZulipCredentials = {
      serverUrl: parsed.realm,
      email: parsed.email,
      apiKey
    }

    pendingResolve?.(creds)
  } catch (err) {
    console.error('[sso] failed to decrypt api key:', err)
    pendingResolve?.(null)
  }

  pendingOtp = null
  pendingResolve = null
  return true
}

// check if SSO is supported on this platform
export function isSsoSupported(): boolean {
  return Capacitor.isNativePlatform()
}

// start SSO login flow
// methodLoginUrl is the login_url from server_settings external_authentication_methods
export async function startSsoLogin(serverUrl: string, methodLoginUrl?: string): Promise<ZulipCredentials | null> {
  const normalizedUrl = serverUrl.replace(/\/$/, '')

  if (!Capacitor.isNativePlatform()) {
    // on web, SSO callback won't work - throw error to show message
    throw new Error('SSO login requires the mobile app. Use password login or import a zuliprc file instead.')
  }

  // generate otp
  pendingOtp = generateOtp()
  console.log('[sso] generated otp, starting browser login')

  // build login url with mobile_flow_otp
  // use the specific method's login_url if provided, otherwise fall back to /login/
  const basePath = methodLoginUrl || '/login/'
  const baseUrl = new URL(basePath, normalizedUrl)
  baseUrl.searchParams.set('mobile_flow_otp', pendingOtp)
  const loginUrl = baseUrl.toString()

  console.log('[sso] opening:', loginUrl)

  return new Promise((resolve) => {
    pendingResolve = resolve

    // listen for browser close - resolve null if user cancels
    Browser.addListener('browserFinished', () => {
      console.log('[sso] browser closed')
      // small delay to allow deep link callback to arrive first
      setTimeout(() => {
        if (pendingResolve) {
          console.log('[sso] no callback received, resolving null')
          pendingResolve(null)
          pendingResolve = null
          pendingOtp = null
        }
      }, 500)
    })

    // on native, open in system browser
    Browser.open({ url: loginUrl })
  })
}

// setup deep link listener (call once on app init)
export function setupSsoListener(): void {
  if (!Capacitor.isNativePlatform()) return

  CapApp.addListener('appUrlOpen', ({ url }) => {
    console.log('[sso] app url open:', url)
    handleSsoCallback(url)
  })

  console.log('[sso] deep link listener registered')
}
