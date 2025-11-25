import { app } from './lib/app.ts'
import type { AppState, ZulipCredentials } from './lib/types.ts'
import './styles.css'

// dom element refs
const setupForm = document.getElementById('setup-form') as HTMLFormElement
const statusPanel = document.getElementById('status-panel') as HTMLDivElement
const serverInput = document.getElementById('server-url') as HTMLInputElement
const emailInput = document.getElementById('email') as HTMLInputElement
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement
const clearCredsBtn = document.getElementById('clear-creds-btn') as HTMLButtonElement
const statusIndicator = document.getElementById('status-indicator') as HTMLSpanElement
const statusText = document.getElementById('status-text') as HTMLSpanElement
const lastUpdateEl = document.getElementById('last-update') as HTMLSpanElement
const errorEl = document.getElementById('error-message') as HTMLDivElement
const keepaliveInput = document.getElementById('keepalive') as HTMLInputElement

// track if we've done initial form population
let formPopulated = false
let settingsPopulated = false

// render ui based on current state
function render(state: AppState): void {
  const hasCredentials = !!state.credentials
  const isConnected = state.connectionState === 'connected'
  const isConnecting = state.connectionState === 'connecting'

  // show/hide panels
  setupForm.classList.toggle('hidden', isConnected)
  statusPanel.classList.toggle('hidden', !hasCredentials)

  // populate form once on load with saved creds
  if (state.credentials && !formPopulated) {
    serverInput.value = state.credentials.serverUrl
    emailInput.value = state.credentials.email
    apiKeyInput.value = state.credentials.apiKey
    formPopulated = true
  }

  // populate settings once
  if (!settingsPopulated) {
    keepaliveInput.value = state.settings.keepaliveSec.toString()
    settingsPopulated = true
  }

  // update status indicator
  statusIndicator.className = `status-dot ${state.connectionState}`
  statusText.textContent = getStatusLabel(state.connectionState)

  // last update time
  if (state.lastEventTime) {
    const ago = Math.round((Date.now() - state.lastEventTime) / 1000)
    lastUpdateEl.textContent = ago < 5 ? 'just now' : `${ago}s ago`
  } else {
    lastUpdateEl.textContent = '-'
  }

  // buttons
  connectBtn.disabled = isConnecting || isConnected
  connectBtn.textContent = isConnecting ? 'Connecting...' : 'Connect'
  disconnectBtn.disabled = !isConnected
  clearCredsBtn.disabled = isConnecting

  // error display
  if (state.error) {
    errorEl.textContent = state.error
    errorEl.classList.remove('hidden')
  } else {
    errorEl.classList.add('hidden')
  }
}

function getStatusLabel(state: string): string {
  switch (state) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting...'
    case 'error': return 'Error'
    default: return 'Disconnected'
  }
}

// form submission - save creds and connect
setupForm.addEventListener('submit', async (e) => {
  e.preventDefault()

  const creds: ZulipCredentials = {
    serverUrl: serverInput.value.trim(),
    email: emailInput.value.trim(),
    apiKey: apiKeyInput.value.trim()
  }

  if (!creds.serverUrl || !creds.email || !creds.apiKey) {
    return
  }

  await app.setCredentials(creds)
  await app.connect()
})

// disconnect button
disconnectBtn.addEventListener('click', () => {
  app.disconnect()
})

// clear credentials
clearCredsBtn.addEventListener('click', async () => {
  if (confirm('Clear saved credentials?')) {
    await app.clearCredentials()
    serverInput.value = ''
    emailInput.value = ''
    apiKeyInput.value = ''
    formPopulated = false
  }
})

// re-connect button (when disconnected but has creds)
connectBtn.addEventListener('click', () => {
  app.connect()
})

// settings change
keepaliveInput.addEventListener('change', () => {
  const val = parseInt(keepaliveInput.value, 10)
  if (val >= 30 && val <= 300) {
    app.setSettings({ keepaliveSec: val })
  }
})

// periodic ui refresh for "last update" counter
setInterval(() => {
  render(app.getState())
}, 1000)

// subscribe to state changes
app.onStateChange(render)

// init on load
app.init()
