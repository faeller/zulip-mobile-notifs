<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { app } from './lib/app'
import type { AppState, ZulipCredentials } from './lib/types'

// reactive state from app
const state = ref<AppState>(app.getState())

// form inputs (not directly bound to state)
const serverUrl = ref('')
const email = ref('')
const apiKey = ref('')
const keepaliveSec = ref(90)

// computed helpers
const hasCredentials = computed(() => !!state.value.credentials)
const isConnected = computed(() => state.value.connectionState === 'connected')
const isConnecting = computed(() => state.value.connectionState === 'connecting')

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
  return ago < 5 ? 'just now' : `${ago}s ago`
})

// subscribe to app state
let unsubscribe: (() => void) | null = null
let updateInterval: number | null = null

onMounted(() => {
  unsubscribe = app.onStateChange((newState) => {
    state.value = newState

    // populate form on first load
    if (newState.credentials && !serverUrl.value) {
      serverUrl.value = newState.credentials.serverUrl
      email.value = newState.credentials.email
      apiKey.value = newState.credentials.apiKey
    }
    keepaliveSec.value = newState.settings.keepaliveSec
  })

  // periodic refresh for "last update" counter
  updateInterval = window.setInterval(() => {
    state.value = { ...app.getState() }
  }, 1000)

  app.init()
})

onUnmounted(() => {
  unsubscribe?.()
  if (updateInterval) clearInterval(updateInterval)
})

// actions
async function handleConnect() {
  const creds: ZulipCredentials = {
    serverUrl: serverUrl.value.trim(),
    email: email.value.trim(),
    apiKey: apiKey.value.trim()
  }
  if (!creds.serverUrl || !creds.email || !creds.apiKey) return

  await app.setCredentials(creds)
  await app.connect()
}

function handleDisconnect() {
  app.disconnect()
}

async function handleClear() {
  if (confirm('Clear saved credentials?')) {
    await app.clearCredentials()
    serverUrl.value = ''
    email.value = ''
    apiKey.value = ''
  }
}

function handleKeepaliveChange() {
  const val = keepaliveSec.value
  if (val >= 30 && val <= 300) {
    app.setSettings({ keepaliveSec: val })
  }
}
</script>

<template>
  <div class="container">
    <header>
      <h1>Zulip Notifications</h1>
      <p class="subtitle">Get browser notifications for Zulip messages</p>
    </header>

    <div v-if="state.error" class="error">
      {{ state.error }}
    </div>

    <form v-if="!isConnected" class="card" @submit.prevent="handleConnect">
      <h2>Setup</h2>

      <div class="field">
        <label for="server-url">Zulip Server URL</label>
        <input
          id="server-url"
          v-model="serverUrl"
          type="url"
          placeholder="https://your-org.zulipchat.com"
          required
        >
      </div>

      <div class="field">
        <label for="email">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          placeholder="you@example.com"
          required
        >
      </div>

      <div class="field">
        <label for="api-key">API Key</label>
        <input
          id="api-key"
          v-model="apiKey"
          type="password"
          placeholder="Your Zulip API key"
          required
        >
        <small>Find this in Zulip: Settings → Account & privacy → API key</small>
      </div>

      <div class="actions">
        <button
          type="submit"
          class="primary"
          :disabled="isConnecting || isConnected"
        >
          {{ isConnecting ? 'Connecting...' : 'Connect' }}
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="isConnecting"
          @click="handleClear"
        >
          Clear
        </button>
      </div>
    </form>

    <div v-if="hasCredentials" class="card">
      <h2>Status</h2>

      <div class="status-row">
        <span>Connection:</span>
        <span>
          <span class="status-dot" :class="state.connectionState"></span>
          {{ statusLabel }}
        </span>
      </div>

      <div class="status-row">
        <span>Last update:</span>
        <span>{{ lastUpdateText }}</span>
      </div>

      <div class="actions">
        <button
          type="button"
          class="secondary"
          :disabled="!isConnected"
          @click="handleDisconnect"
        >
          Disconnect
        </button>
      </div>
    </div>

    <div class="card">
      <h2>Settings</h2>

      <div class="field">
        <label for="keepalive">Connection keepalive (seconds)</label>
        <input
          id="keepalive"
          v-model.number="keepaliveSec"
          type="number"
          min="30"
          max="300"
          @change="handleKeepaliveChange"
        >
        <small>
          Messages arrive instantly. This just controls how often we verify
          the connection is still alive when idle. Higher = less overhead.
        </small>
      </div>
    </div>

    <footer>
      <p class="notice">Keep this tab open to receive notifications. Credentials stored locally.</p>
      <a href="https://github.com/faeller/zulip-mobile-notifs" target="_blank" class="github-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
        </svg>
        GitHub
      </a>
    </footer>
  </div>
</template>

<style>
@import './styles.css';
</style>
