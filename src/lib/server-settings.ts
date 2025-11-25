// fetch server settings to determine auth methods
// GET /api/v1/server_settings (no auth required)

export interface ExternalAuthMethod {
  name: string
  display_name: string
  display_icon: string | null
  login_url: string
  signup_url: string
}

export interface ServerSettings {
  authentication_methods: {
    password?: boolean
    ldap?: boolean
    email?: boolean
    github?: boolean
    google?: boolean
    saml?: boolean
    azuread?: boolean
    [key: string]: boolean | undefined
  }
  external_authentication_methods: ExternalAuthMethod[]
  realm_name?: string
  realm_icon?: string
  require_email_format_usernames?: boolean
}

export interface AuthInfo {
  supportsPassword: boolean
  supportsSSO: boolean
  ssoMethods: ExternalAuthMethod[]
  realmName?: string
}

export async function getServerSettings(serverUrl: string): Promise<AuthInfo> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/v1/server_settings`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch server settings: ${res.status}`)
  }

  const data: ServerSettings = await res.json()

  // check if password auth is enabled
  const supportsPassword = data.authentication_methods?.password === true ||
                           data.authentication_methods?.ldap === true ||
                           data.authentication_methods?.email === true

  // check for external SSO methods
  const ssoMethods = data.external_authentication_methods || []
  const supportsSSO = ssoMethods.length > 0

  return {
    supportsPassword,
    supportsSSO,
    ssoMethods,
    realmName: data.realm_name
  }
}
