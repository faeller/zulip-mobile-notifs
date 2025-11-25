import type { ZulipCredentials } from './types'

interface FetchApiKeyResponse {
  api_key: string
  email: string
  user_id: number
}

// fetch api key using email + password
// POST /api/v1/fetch_api_key with username={email}&password={password}
export async function fetchApiKey(
  serverUrl: string,
  email: string,
  password: string
): Promise<ZulipCredentials> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/v1/fetch_api_key`

  const body = new URLSearchParams()
  body.append('username', email)
  body.append('password', password)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString()
  })

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Invalid email or password')
    }
    const text = await res.text()
    throw new Error(`Login failed: ${res.status} ${text}`)
  }

  const data: FetchApiKeyResponse = await res.json()

  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    email: data.email,
    apiKey: data.api_key
  }
}
