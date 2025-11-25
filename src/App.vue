<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { app } from './lib/app'
import { pickZuliprc } from './lib/zuliprc'
import { fetchApiKey } from './lib/auth'
import { startSsoLogin, setupSsoListener, isSsoSupported } from './lib/sso-auth'
import { getServerSettings, type AuthInfo, type ExternalAuthMethod } from './lib/server-settings'
import type { AppState, ZulipCredentials } from './lib/types'
import PrivacyNotice from './components/PrivacyNotice.vue'
import BackButton from './components/BackButton.vue'
import RememberToggle from './components/RememberToggle.vue'
import FormField from './components/FormField.vue'
import SavedCredentials from './components/SavedCredentials.vue'

// icons as components for reuse
const LoginIcon = `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>`
const FileIcon = `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>`
const EditIcon = `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`

// screens and selection states
type Screen = 'onboarding' | 'setup' | 'connected'
type Selection = null | 'login' | 'zuliprc' | 'manual'
type LoginStep = 'server' | 'credentials'

const screen = ref<Screen>('onboarding')
const state = ref<AppState>(app.getState())
const selection = ref<Selection>(null)

// login flow state
const loginStep = ref<LoginStep>('server')
const authInfo = ref<AuthInfo | null>(null)

// form inputs
const serverUrl = ref('')
const email = ref('')
const password = ref('')
const apiKey = ref('')
const rememberDetails = ref(true)
const showSettings = ref(true)
const keepaliveSec = ref(90)
const loginError = ref('')
const isLoggingIn = ref(false)
const isCheckingServer = ref(false)
const confirmingLogout = ref(false)

// computed
const isConnecting = computed(() => state.value.connectionState === 'connecting')
const isBusy = computed(() => isConnecting.value || isLoggingIn.value || isCheckingServer.value)
const canUseSso = computed(() => isSsoSupported())

const statusLabel = computed(() => {
  switch (state.value.connectionState) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting...'
    case 'error': return 'Error'
    default: return 'Disconnected'
  }
})

const lastUpdateText = computed(() => {
  if (!state.value.lastEventTime) return '-'
  const ago = Math.round((Date.now() - state.value.lastEventTime) / 1000)
  if (ago < 5) return 'just now'
  if (ago < 60) return `${ago}s ago`
  return `${Math.floor(ago / 60)}m ago`
})

// subscribe to app state
let unsubscribe: (() => void) | null = null
let updateInterval: number | null = null

onMounted(() => {
  unsubscribe = app.onStateChange((newState) => {
    state.value = newState

    if (newState.connectionState === 'connected') {
      screen.value = 'connected'
    } else if (newState.savedAccounts.length > 0 && screen.value === 'onboarding') {
      // have saved accounts, go to setup screen
      screen.value = 'setup'
    }

    keepaliveSec.value = newState.settings.keepaliveSec
  })

  updateInterval = window.setInterval(() => {
    state.value = { ...app.getState() }
  }, 1000)

  app.init()
  setupSsoListener()
})

onUnmounted(() => {
  unsubscribe?.()
  if (updateInterval) clearInterval(updateInterval)
})

// navigation
function startSetup() {
  screen.value = 'setup'
}

function selectOption(opt: Selection) {
  selection.value = opt
  loginError.value = ''
}

function clearSelection() {
  selection.value = null
  loginStep.value = 'server'
  authInfo.value = null
  loginError.value = ''
}

function goBackToServer() {
  loginStep.value = 'server'
  authInfo.value = null
  loginError.value = ''
}

// zuliprc import
async function handleSelectZuliprc() {
  const creds = await pickZuliprc()
  if (creds) {
    creds.authMethod = 'zuliprc'
    await app.connect(creds, rememberDetails.value)
  }
}

// use saved account
async function handleUseAccount(creds: ZulipCredentials) {
  await app.connect(creds)
}

// delete saved account
async function handleDeleteAccount(creds: ZulipCredentials) {
  await app.removeAccount(creds)
}

// login flow
async function handleCheckServer() {
  const server = serverUrl.value.trim()
  if (!server) return

  loginError.value = ''
  isCheckingServer.value = true

  try {
    const info = await getServerSettings(server)
    authInfo.value = info
    loginStep.value = 'credentials'
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : 'Could not connect to server'
  } finally {
    isCheckingServer.value = false
  }
}

async function handlePasswordLogin() {
  const server = serverUrl.value.trim()
  const user = email.value.trim()
  const pass = password.value

  if (!server || !user || !pass) return

  loginError.value = ''
  isLoggingIn.value = true

  try {
    const creds = await fetchApiKey(server, user, pass)
    creds.authMethod = 'password'
    password.value = ''
    await app.connect(creds, rememberDetails.value)
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : 'Login failed'
  } finally {
    isLoggingIn.value = false
  }
}

async function handleSsoLogin(method: ExternalAuthMethod) {
  const server = serverUrl.value.trim()
  if (!server) return

  loginError.value = ''
  isLoggingIn.value = true

  try {
    const creds = await startSsoLogin(server, method.login_url)
    if (creds) {
      creds.authMethod = 'sso'
      await app.connect(creds, rememberDetails.value)
    } else {
      loginError.value = 'SSO login cancelled or failed'
    }
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : 'SSO login failed'
  } finally {
    isLoggingIn.value = false
  }
}

async function handleManualConnect() {
  const creds: ZulipCredentials = {
    serverUrl: serverUrl.value.trim(),
    email: email.value.trim(),
    apiKey: apiKey.value.trim(),
    authMethod: 'manual'
  }
  if (!creds.serverUrl || !creds.email || !creds.apiKey) return

  await app.connect(creds, rememberDetails.value)
}

async function handleDisconnect() {
  await app.disconnect()
  screen.value = 'setup'
  selection.value = null
}

function handleLogoutClick() {
  if (confirmingLogout.value) {
    handleLogoutConfirmed()
  } else {
    confirmingLogout.value = true
  }
}

async function handleLogoutConfirmed() {
  confirmingLogout.value = false
  // remove the active account and disconnect
  if (state.value.activeAccount) {
    await app.removeAccount(state.value.activeAccount)
  } else {
    await app.disconnect()
  }
  serverUrl.value = ''
  email.value = ''
  password.value = ''
  apiKey.value = ''
  selection.value = null
  loginStep.value = 'server'
  authInfo.value = null
  screen.value = state.value.savedAccounts.length > 0 ? 'setup' : 'onboarding'
}

function cancelLogout() {
  confirmingLogout.value = false
}

function handleKeepaliveChange() {
  const val = keepaliveSec.value
  if (val >= 30 && val <= 300) {
    app.setSettings({ keepaliveSec: val })
  }
}
</script>

<template>
  <div class="app">
    <!-- onboarding screen -->
    <div v-if="screen === 'onboarding'" class="screen onboarding">
      <div class="hero">
        <img src="/icon.svg" alt="Zulip Notifications" class="app-icon" />
        <h1>Zulip Notifications</h1>
        <p class="tagline">Unofficial app, not affiliated with Zulip</p>
      </div>

      <div class="features">
        <div class="feature">
          <svg class="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          <span>Instant notifications for PMs and @mentions</span>
        </div>
        <div class="feature">
          <svg class="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span>Credentials stored locally on your device</span>
        </div>
        <div class="feature">
          <svg class="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="1" y="6" width="18" height="12" rx="2"/>
            <line x1="23" y1="13" x2="23" y2="11"/>
          </svg>
          <span>Runs in background with minimal battery usage</span>
        </div>
      </div>

      <button class="primary large" @click="startSetup">
        Get Started
      </button>

      <p class="copyright">© 2025 Merle Fäller</p>
    </div>

    <!-- setup screen -->
    <div v-if="screen === 'setup'" class="screen setup">
      <BackButton v-if="!selection" label="Back" @click="screen = 'onboarding'" class="top-back-btn" />
      <div class="setup-content">
        <header class="screen-header centered-header">
          <img src="/icon.svg" alt="" class="header-icon" />
          <h1>Connect to Zulip</h1>
        </header>

        <PrivacyNotice />

        <div v-if="state.error" class="error">
          {{ state.error }}
        </div>

        <!-- option selection -->
        <div class="setup-options">
          <!-- no selection: show all options -->
          <template v-if="!selection">
            <button class="option-btn" @click="selectOption('login')" :disabled="isBusy">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="LoginIcon" />
              </span>
              <span class="option-text">
                <strong>Login (recommended)</strong>
                <small>Password or SSO</small>
              </span>
            </button>

            <button class="option-btn" @click="selectOption('zuliprc')" :disabled="isBusy">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="FileIcon" />
              </span>
              <span class="option-text">
                <strong>Import zuliprc file</strong>
                <small>Download from Zulip settings</small>
              </span>
            </button>

            <button class="option-btn" @click="selectOption('manual')" :disabled="isBusy">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="EditIcon" />
              </span>
              <span class="option-text">
                <strong>Enter API key manually</strong>
                <small>Server URL, email, and API key</small>
              </span>
            </button>
          </template>

          <!-- login selected -->
          <template v-if="selection === 'login'">
            <BackButton label="Other options" @click="clearSelection" class="selection-back" />
            <div class="option-btn active selected-option">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="LoginIcon" />
              </span>
              <span class="option-text">
                <strong>Login (recommended)</strong>
                <small>Password or SSO</small>
              </span>
            </div>
          </template>

          <!-- zuliprc selected -->
          <template v-if="selection === 'zuliprc'">
            <BackButton label="Other options" @click="clearSelection" class="selection-back" />
            <div class="option-btn active selected-option">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="FileIcon" />
              </span>
              <span class="option-text">
                <strong>Import zuliprc file</strong>
                <small>Download from Zulip settings</small>
              </span>
            </div>
          </template>

          <!-- manual selected -->
          <template v-if="selection === 'manual'">
            <BackButton label="Other options" @click="clearSelection" class="selection-back" />
            <div class="option-btn active selected-option">
              <span class="option-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="EditIcon" />
              </span>
              <span class="option-text">
                <strong>Enter API key manually</strong>
                <small>Server URL, email, and API key</small>
              </span>
            </div>
          </template>

          <!-- saved accounts shown below options when no selection -->
          <template v-if="!selection && state.savedAccounts.length > 0">
            <div class="divider saved-divider"><span>or use saved</span></div>
            <div class="saved-accounts-list">
              <SavedCredentials
                v-for="account in state.savedAccounts"
                :key="account.serverUrl + '::' + account.email"
                :credentials="account"
                :disabled="isBusy"
                @use="handleUseAccount(account)"
                @delete="handleDeleteAccount(account)"
              />
            </div>
          </template>
        </div>

        <!-- login flow -->
        <div v-if="selection === 'login'" class="form-section">
          <div v-if="loginError" class="error">{{ loginError }}</div>

          <!-- step 1: server url -->
          <template v-if="loginStep === 'server'">
            <FormField label="Server URL">
              <input
                v-model="serverUrl"
                type="url"
                placeholder="https://chat.zulip.org"
                @keyup.enter="handleCheckServer"
              >
            </FormField>

            <RememberToggle v-model="rememberDetails" />

            <button class="primary" :disabled="isBusy" @click="handleCheckServer">
              {{ isCheckingServer ? 'Checking...' : 'Continue' }}
            </button>
          </template>

          <!-- step 2: credentials -->
          <template v-if="loginStep === 'credentials' && authInfo">
            <BackButton :label="serverUrl" @click="goBackToServer" class="server-back" />

            <div v-if="authInfo.realmName" class="realm-name">
              {{ authInfo.realmName }}
            </div>

            <!-- SSO options (native only) -->
            <div v-if="authInfo.supportsSSO && canUseSso" class="auth-section">
              <button
                v-for="method in authInfo.ssoMethods"
                :key="method.name"
                class="sso-btn"
                :disabled="isBusy"
                @click="handleSsoLogin(method)"
              >
                <img v-if="method.display_icon" :src="method.display_icon" :alt="method.display_name" class="sso-icon">
                <span>Continue with {{ method.display_name }}</span>
              </button>

              <RememberToggle v-model="rememberDetails" />
            </div>

            <!-- SSO not available on web -->
            <div v-if="authInfo.supportsSSO && !canUseSso && !authInfo.supportsPassword" class="sso-web-notice">
              This server only supports SSO, which requires the mobile app. Please import a zuliprc file or enter your API key manually.
            </div>

            <!-- password login -->
            <template v-if="authInfo.supportsPassword">
              <div v-if="authInfo.supportsSSO && canUseSso" class="divider"><span>or</span></div>

              <form @submit.prevent="handlePasswordLogin">
                <FormField label="Email">
                  <input v-model="email" type="email" placeholder="you@example.com" required>
                </FormField>

                <FormField label="Password">
                  <input v-model="password" type="password" placeholder="Your Zulip password" required>
                </FormField>

                <RememberToggle v-model="rememberDetails" />

                <button type="submit" class="primary" :disabled="isBusy">
                  {{ isLoggingIn ? 'Logging in...' : 'Login' }}
                </button>
              </form>
            </template>

            <div v-if="!authInfo.supportsPassword && !authInfo.supportsSSO" class="no-auth-warning">
              No supported authentication methods found. Try importing a zuliprc file instead.
            </div>
          </template>
        </div>

        <!-- zuliprc flow -->
        <div v-if="selection === 'zuliprc'" class="form-section">
          <p class="help-text">
            Download your zuliprc file from Zulip:<br>
            Settings -> Account & privacy -> API key -> Download .zuliprc
          </p>

          <button class="primary" :disabled="isBusy" @click="handleSelectZuliprc">
            Select zuliprc file
          </button>

          <RememberToggle v-model="rememberDetails" />
        </div>

        <!-- manual entry flow -->
        <form v-if="selection === 'manual'" class="form-section" @submit.prevent="handleManualConnect">
          <FormField label="Server URL">
            <input v-model="serverUrl" type="url" placeholder="https://chat.zulip.org" required>
          </FormField>

          <FormField label="Email">
            <input v-model="email" type="email" placeholder="you@example.com" required>
          </FormField>

          <FormField label="API Key" hint="Settings -> Account & privacy -> API key">
            <input v-model="apiKey" type="password" placeholder="Your Zulip API key" required>
          </FormField>

          <RememberToggle v-model="rememberDetails" />

          <button type="submit" class="primary" :disabled="isBusy">
            {{ isConnecting ? 'Connecting...' : 'Connect' }}
          </button>
        </form>
      </div>
    </div>

    <!-- connected screen -->
    <div v-if="screen === 'connected'" class="screen connected">
      <header class="navbar">
        <div class="navbar-brand">
          <img src="/icon.svg" alt="" class="navbar-icon" />
          <span>Zulip Notifications</span>
        </div>
      </header>

      <div class="status-card">
        <div class="status-indicator" :class="state.connectionState">
          <span class="pulse"></span>
        </div>
        <div class="status-info">
          <strong>{{ statusLabel }}</strong>
          <span class="status-detail">Last update: {{ lastUpdateText }}</span>
        </div>
      </div>

      <div v-if="state.error" class="error">
        {{ state.error }}
      </div>

      <div class="connected-info">
        <div class="info-row">
          <span class="info-label">Server</span>
          <span class="info-value">{{ state.activeAccount?.serverUrl }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Account</span>
          <span class="info-value">{{ state.activeAccount?.email }}</span>
        </div>
      </div>

      <button class="settings-toggle" @click="showSettings = !showSettings">
        {{ showSettings ? 'Hide settings' : 'Settings' }}
      </button>

      <div v-if="showSettings" class="settings">
        <FormField label="Keepalive interval (seconds)" hint="How often to check connection when idle">
          <input
            v-model.number="keepaliveSec"
            type="number"
            min="30"
            max="300"
            @change="handleKeepaliveChange"
          >
        </FormField>
      </div>

      <div class="actions-wrapper">
        <div v-if="confirmingLogout" class="logout-hint" @click="cancelLogout">
          tap to cancel
        </div>
        <div class="actions">
          <button
            class="secondary"
            :class="{ 'confirming-delete': confirmingLogout }"
            @click="handleLogoutClick"
          >
            {{ confirmingLogout ? 'Confirm?' : 'Logout & Delete' }}
          </button>
          <button class="danger" @click="handleDisconnect">Disconnect</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import './styles.css';
</style>
