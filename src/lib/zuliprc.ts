import type { ZulipCredentials } from './types'

// parse zuliprc ini file format
// format:
// [api]
// email=user@example.com
// key=abc123
// site=https://chat.example.com
export function parseZuliprc(content: string): ZulipCredentials | null {
  const lines = content.split('\n')
  let email = ''
  let apiKey = ''
  let serverUrl = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('email=')) {
      email = trimmed.slice(6).trim()
    } else if (trimmed.startsWith('key=')) {
      apiKey = trimmed.slice(4).trim()
    } else if (trimmed.startsWith('site=')) {
      serverUrl = trimmed.slice(5).trim()
    }
  }

  if (!email || !apiKey || !serverUrl) {
    return null
  }

  return { email, apiKey, serverUrl }
}

// pick and read zuliprc file using standard file input (works on web + native)
export function pickZuliprc(): Promise<ZulipCredentials | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    // don't filter - zuliprc files may not be recognized

    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }

      try {
        const content = await file.text()
        const creds = parseZuliprc(content)
        if (!creds) {
          console.error('[zuliprc] failed to parse file')
        }
        resolve(creds)
      } catch (err) {
        console.error('[zuliprc] failed to read file:', err)
        resolve(null)
      }
    }

    // handle cancel
    input.oncancel = () => resolve(null)

    input.click()
  })
}
