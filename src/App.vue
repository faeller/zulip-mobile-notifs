<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { app } from './lib/app'
import { pickZuliprc } from './lib/zuliprc'
import { fetchApiKey } from './lib/auth'
import { startSsoLogin, setupSsoListener, isSsoSupported } from './lib/sso-auth'
import { pickNotificationSound, pickSoundFile, downloadAndSetSound, startForegroundService, stopForegroundService } from './lib/foreground-service'
import { isPushSupported, subscribeToPush, unsubscribeFromPush, registerWithPusher, unregisterFromPusher, getExistingSubscription, updatePusherFilters, testPush } from './lib/web-push'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { getServerSettings, type AuthInfo, type ExternalAuthMethod } from './lib/server-settings'
import { notifications } from './lib/notifications'
import type { AppState, ZulipCredentials, NotificationMethod } from './lib/types'
import { DEFAULT_PUSHER_URL } from './lib/types'
import PrivacyNotice from './components/PrivacyNotice.vue'
import NotificationMethodSelector from './components/NotificationMethodSelector.vue'
import BackButton from './components/BackButton.vue'
import RememberToggle from './components/RememberToggle.vue'
import FormField from './components/FormField.vue'
import SavedCredentials from './components/SavedCredentials.vue'
import Toast from './components/Toast.vue'
import SelfHostLink from './components/SelfHostLink.vue'

// icons as components for reuse
const LoginIcon = `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>`
const FileIcon = `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>`
const EditIcon = `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`

// screens and selection states
type Screen = 'onboarding' | 'setup' | 'method-select' | 'connected'
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
const playSounds = ref(true)
const groupByConversation = ref(true)
const vibrate = ref(true)
const openZulipApp = ref(true)
const showTimestamps = ref(false)
const notificationSound = ref<string | null>(null)
const notificationSoundTitle = ref<string | null>(null)
// filters
const notifyOnMention = ref(true)
const notifyOnDM = ref(true)
const notifyOnOther = ref(false)
const muteSelfMessages = ref(true)
const mutedStreams = ref<string[]>([])
const mutedTopics = ref<string[]>([])
const mutedStreamsInput = ref('')
const mutedTopicsInput = ref('')
// server-fetched mute suggestions
const serverChannels = ref<{ name: string; is_muted: boolean }[]>([])
const serverTopics = ref<{ stream_name: string; topic: string }[]>([])
const loadingChannels = ref(false)
const loadingTopics = ref(false)
const showChannelSuggestions = ref(false)
const showTopicSuggestions = ref(false)
// quiet hours
const quietHoursEnabled = ref(false)
const quietHoursStart = ref('22:00')
const quietHoursEnd = ref('07:00')
// quiet days (0=sunday, 6=saturday)
const quietDaysEnabled = ref(false)
const quietDays = ref<number[]>([])
// display order: mon-sun, with actual day index for each
const weekdays = [
  { label: 'Mon', day: 1 },
  { label: 'Tue', day: 2 },
  { label: 'Wed', day: 3 },
  { label: 'Thu', day: 4 },
  { label: 'Fri', day: 5 },
  { label: 'Sat', day: 6 },
  { label: 'Sun', day: 0 },
]
// privacy
const analyticsEnabled = ref(true)
// developer mode
const devMode = ref(false)
const useJSService = ref(false)
const devTapCount = ref(0)
const devTapTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
const devTapMessage = ref('')
const devTapMessageTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
// notification method
const notificationMethod = ref<NotificationMethod | null>(null)
const notificationMethodConfigured = ref(false)
const pendingMethod = ref<NotificationMethod | null>(null) // for cloud confirmation
// cloud push
const cloudPushEnabled = ref(false)
const cloudPushUrl = ref(DEFAULT_PUSHER_URL)
const cloudPushStatus = ref<'idle' | 'checking' | 'online' | 'offline' | 'registering' | 'registered' | 'error'>('idle')
const cloudPushError = ref('')
const loginError = ref('')
const isLoggingIn = ref(false)
const isCheckingServer = ref(false)
const confirmingLogout = ref(false)

// computed
const isConnecting = computed(() => state.value.connectionState === 'connecting')
const isBusy = computed(() => isConnecting.value || isLoggingIn.value || isCheckingServer.value)
const canUseSso = computed(() => isSsoSupported())
const isNativePlatform = computed(() => Capacitor.isNativePlatform())

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

const soundDisplayName = computed(() => {
  if (!notificationSound.value) return 'Default'
  if (notificationSoundTitle.value) return notificationSoundTitle.value
  // fallback: extract filename from path
  const name = notificationSound.value.split('/').pop() || notificationSound.value
  return name.replace(/^notification_sound_/, '').replace(/_/g, ' ')
})

const cloudPushStatusText = computed(() => {
  switch (cloudPushStatus.value) {
    case 'checking': return 'Checking server...'
    case 'online': return 'Server online'
    case 'offline': return 'Server offline'
    case 'registering': return 'Registering...'
    case 'registered': return 'Active'
    case 'error': return 'Error'
    default: return ''
  }
})

const methodDisplayName = computed(() => {
  switch (notificationMethod.value) {
    case 'tab-only': return 'Tab Only'
    case 'web-push': return 'Web Push'
    case 'foreground-service': return 'Foreground Service'
    default: return 'Not set'
  }
})

// subscribe to app state
let unsubscribe: (() => void) | null = null
let updateInterval: number | null = null

onMounted(async () => {
  unsubscribe = app.onStateChange((newState) => {
    state.value = newState

    if (newState.connectionState === 'connected') {
      // load notification method from active account
      const account = newState.activeAccount
      if (account?.notificationMethod) {
        notificationMethod.value = account.notificationMethod
        notificationMethodConfigured.value = true
        if (account.cloudPushUrl) {
          cloudPushUrl.value = account.cloudPushUrl
        }
        // setup the method (cloud push etc)
        setupNotificationMethod(account.notificationMethod)
        screen.value = 'connected'
      } else {
        // first time - show method selection
        screen.value = 'method-select'
      }
    } else if (newState.savedAccounts.length > 0 && screen.value === 'onboarding') {
      // have saved accounts, go to setup screen
      screen.value = 'setup'
    }
  })

  updateInterval = window.setInterval(() => {
    state.value = { ...app.getState() }
  }, 1000)

  await app.init()
  setupSsoListener()

  // init settings after loaded from storage
  const settings = app.getState().settings
  playSounds.value = settings.playSounds ?? true
  groupByConversation.value = settings.groupByConversation
  vibrate.value = settings.vibrate
  openZulipApp.value = settings.openZulipApp
  showTimestamps.value = settings.showTimestamps
  notificationSound.value = settings.notificationSound
  notificationSoundTitle.value = settings.notificationSoundTitle
  // filters
  notifyOnMention.value = settings.notifyOnMention ?? true
  notifyOnDM.value = settings.notifyOnDM ?? (settings as any).notifyOnPM ?? true
  notifyOnOther.value = settings.notifyOnOther ?? false
  muteSelfMessages.value = settings.muteSelfMessages ?? true
  mutedStreams.value = settings.mutedStreams || []
  mutedTopics.value = settings.mutedTopics || []
  // quiet hours
  quietHoursEnabled.value = settings.quietHoursEnabled
  quietHoursStart.value = settings.quietHoursStart || '22:00'
  quietHoursEnd.value = settings.quietHoursEnd || '07:00'
  // quiet days
  quietDaysEnabled.value = settings.quietDaysEnabled ?? false
  quietDays.value = settings.quietDays || []
  // privacy
  analyticsEnabled.value = settings.analyticsEnabled ?? true
  // developer mode
  devMode.value = settings.devMode ?? false
  useJSService.value = settings.useJSService ?? false
  // notification method
  notificationMethod.value = settings.notificationMethod ?? null
  notificationMethodConfigured.value = settings.notificationMethodConfigured ?? false
  // cloud push
  cloudPushEnabled.value = settings.cloudPushEnabled ?? false
  cloudPushUrl.value = settings.cloudPushUrl || DEFAULT_PUSHER_URL

  // restore cloud push state on reload
  if (cloudPushEnabled.value && isPushSupported()) {
    const existingSub = await getExistingSubscription()
    if (existingSub) {
      // subscription exists, mark as registered
      cloudPushStatus.value = 'registered'
    } else {
      // subscription lost, reset state
      cloudPushEnabled.value = false
      cloudPushStatus.value = 'idle'
      // save the reset state
      handleNotificationSettingChange()
    }
  }

  // handle android back button
  CapApp.addListener('backButton', () => {
    if (screen.value === 'connected') {
      // don't navigate away from connected screen
      return
    }
    if (selection.value) {
      if (loginStep.value === 'credentials') {
        goBackToServer()
      } else {
        clearSelection()
      }
    } else if (screen.value === 'setup') {
      screen.value = 'onboarding'
    }
  })
})

onUnmounted(() => {
  unsubscribe?.()
  if (updateInterval) clearInterval(updateInterval)
  CapApp.removeAllListeners()
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

// tap icon 8 times to enable dev mode (like android dev options)
function handleDevTap() {
  if (devMode.value) return // already enabled

  devTapCount.value++

  // reset counter after 2 seconds of no taps
  if (devTapTimeout.value) clearTimeout(devTapTimeout.value)
  devTapTimeout.value = setTimeout(() => {
    devTapCount.value = 0
    devTapMessage.value = ''
  }, 2000)

  // show progress feedback
  const remaining = 8 - devTapCount.value
  if (remaining <= 3 && remaining > 0) {
    showDevTapMessage(`${remaining} taps to enable developer mode`)
  }

  if (devTapCount.value >= 8) {
    devMode.value = true
    devTapCount.value = 0
    handleNotificationSettingChange()
    showDevTapMessage('Developer mode enabled!')
  }
}

function showDevTapMessage(msg: string) {
  devTapMessage.value = msg
  if (devTapMessageTimeout.value) clearTimeout(devTapMessageTimeout.value)
  devTapMessageTimeout.value = setTimeout(() => {
    devTapMessage.value = ''
  }, 2000)
}

// switch between native and JS polling service
async function handleServiceChange() {
  handleNotificationSettingChange()
  // restart service to apply change
  if (Capacitor.isNativePlatform()) {
    console.log('[dev] service preference changed, restarting...')
    await stopForegroundService()
    await startForegroundService()
  }
}

// cloud push handlers

const showPwaDialog = ref(false)

function openPwaInBrowser() {
  window.open('https://faeller.github.io/zulip-mobile-notifs/', '_blank')
  showPwaDialog.value = false
}

// handle notification method selection (from method-select screen or settings)
async function handleMethodSelect(method: NotificationMethod) {
  // already using this method, do nothing
  if (method === notificationMethod.value) {
    screen.value = 'connected'
    return
  }

  // web-push on android needs PWA
  if (method === 'web-push' && Capacitor.isNativePlatform()) {
    showPwaDialog.value = true
    return
  }

  // web-push needs confirmation (sends credentials to server)
  if (method === 'web-push' && !pendingMethod.value) {
    pendingMethod.value = method
    return // wait for confirmation
  }

  // clear pending state
  pendingMethod.value = null

  // disable current method first
  if (notificationMethod.value === 'web-push' && cloudPushEnabled.value) {
    await disableCloudPush()
    cloudPushEnabled.value = false
  }
  if (notificationMethod.value === 'foreground-service' && Capacitor.isNativePlatform()) {
    await stopForegroundService()
  }

  notificationMethod.value = method
  notificationMethodConfigured.value = true

  // enable the selected method
  if (method === 'web-push') {
    cloudPushEnabled.value = true
    await enableCloudPush()
  } else if (method === 'foreground-service' && Capacitor.isNativePlatform()) {
    await startForegroundService()
  }
  // tab-only: nothing extra needed, just polls when connected

  // save to account
  if (state.value.activeAccount) {
    state.value.activeAccount.notificationMethod = method
    state.value.activeAccount.cloudPushUrl = cloudPushUrl.value
    await app.saveAccount(state.value.activeAccount)
  }

  // save global settings
  handleNotificationSettingChange()

  // go to connected screen
  screen.value = 'connected'
}

function cancelCloudConfirmation() {
  pendingMethod.value = null
}

const isConfirming = ref(false)

async function confirmCloudMethod() {
  if (!pendingMethod.value || isConfirming.value) return
  isConfirming.value = true

  const method = pendingMethod.value
  pendingMethod.value = null

  notificationMethod.value = method
  notificationMethodConfigured.value = true

  // enable cloud push
  cloudPushEnabled.value = true
  await enableCloudPush()

  // save to account
  if (state.value.activeAccount) {
    state.value.activeAccount.notificationMethod = method
    state.value.activeAccount.cloudPushUrl = cloudPushUrl.value
    await app.saveAccount(state.value.activeAccount)
  }

  handleNotificationSettingChange()
  screen.value = 'connected'
  isConfirming.value = false
}


// setup notification method (called on load from account)
async function setupNotificationMethod(method: NotificationMethod) {
  if (method === 'web-push') {
    cloudPushEnabled.value = true
    await enableCloudPush()
  } else if (method === 'foreground-service' && Capacitor.isNativePlatform()) {
    await startForegroundService()
  }
  // tab-only: nothing to setup
}

// save worker URL and re-register
async function saveWorkerUrl() {
  // save to account
  if (state.value.activeAccount) {
    state.value.activeAccount.cloudPushUrl = cloudPushUrl.value
    await app.saveAccount(state.value.activeAccount)
  }
  handleNotificationSettingChange()

  // re-register with new URL
  if (cloudPushEnabled.value) {
    await disableCloudPush()
    await enableCloudPush()
  }
}

// get current filter settings for cloud push
function getCloudPushFilters() {
  return {
    notifyOnMention: notifyOnMention.value,
    notifyOnDM: notifyOnDM.value,
    notifyOnOther: notifyOnOther.value,
    muteSelfMessages: muteSelfMessages.value,
    mutedStreams: mutedStreams.value,
    mutedTopics: mutedTopics.value,
    quietHoursEnabled: quietHoursEnabled.value,
    quietHoursStart: quietHoursStart.value,
    quietHoursEnd: quietHoursEnd.value,
    quietDaysEnabled: quietDaysEnabled.value,
    quietDays: quietDays.value
  }
}

async function enableCloudPush() {
  if (!isPushSupported()) {
    cloudPushError.value = 'push notifications not supported in this browser'
    cloudPushEnabled.value = false
    return
  }

  if (!state.value.activeAccount) {
    cloudPushError.value = 'no active account'
    cloudPushEnabled.value = false
    return
  }

  cloudPushStatus.value = 'registering'
  cloudPushError.value = ''

  try {
    // subscribe to push
    const subscription = await subscribeToPush(cloudPushUrl.value)

    // register with pusher server including filter settings
    const result = await registerWithPusher(
      cloudPushUrl.value,
      subscription,
      state.value.activeAccount.serverUrl,
      state.value.activeAccount.email,
      state.value.activeAccount.apiKey,
      getCloudPushFilters()
    )

    if (result.success) {
      cloudPushStatus.value = 'registered'
      showDevTapMessage('Cloud push enabled')
    } else {
      cloudPushStatus.value = 'error'
      cloudPushError.value = result.error || 'registration failed'
      cloudPushEnabled.value = false
    }
  } catch (err) {
    cloudPushStatus.value = 'error'
    cloudPushError.value = (err as Error).message
    cloudPushEnabled.value = false
  }
}

// sync filter settings to cloud pusher
async function syncCloudPushFilters() {
  if (!cloudPushEnabled.value) return

  const subscription = await getExistingSubscription()
  if (!subscription) return

  const result = await updatePusherFilters(cloudPushUrl.value, subscription.endpoint, getCloudPushFilters())
  if (!result.success) {
    console.error('[cloud-push] sync filters failed:', result.error)
  }
}

// send test push notification via cloud
async function sendTestPush() {
  console.log('[cloud-push] sending test...')
  const subscription = await getExistingSubscription()
  if (!subscription) {
    console.log('[cloud-push] no subscription found')
    showDevTapMessage('No push subscription')
    return
  }

  console.log('[cloud-push] subscription endpoint:', subscription.endpoint.slice(0, 50) + '...')
  const result = await testPush(cloudPushUrl.value, subscription.endpoint)
  console.log('[cloud-push] test result:', result)

  if (result.success) {
    showDevTapMessage('Test sent! Check for notification')
  } else {
    showDevTapMessage(`Failed: ${result.error}`)
    console.error('[cloud-push] test failed:', result.error)
  }
}

// local test - show notification directly from browser (no cloud)
async function sendLocalTestNotification() {
  console.log('[local-test] sending local notification...')

  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      showDevTapMessage('Notification permission denied')
      return
    }
  }

  const reg = await navigator.serviceWorker.ready
  await reg.showNotification('Local Test', {
    body: `This is a local test notification (${new Date().toLocaleTimeString()})`,
    icon: '/pwa-192.png',
    tag: 'local-test'
  })
  showDevTapMessage('Local notification sent!')
}

async function disableCloudPush() {
  try {
    const subscription = await getExistingSubscription()
    if (subscription) {
      await unregisterFromPusher(cloudPushUrl.value, subscription.endpoint)
      await unsubscribeFromPush()
    }
    cloudPushStatus.value = 'idle'
    showDevTapMessage('Cloud push disabled')
  } catch (err) {
    console.error('[cloud-push] disable error:', err)
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

function handleNotificationSettingChange() {
  app.setSettings({
    // notification method
    notificationMethod: notificationMethod.value,
    notificationMethodConfigured: notificationMethodConfigured.value,
    // notification settings
    playSounds: playSounds.value,
    groupByConversation: groupByConversation.value,
    vibrate: vibrate.value,
    openZulipApp: openZulipApp.value,
    showTimestamps: showTimestamps.value,
    notificationSound: notificationSound.value,
    notificationSoundTitle: notificationSoundTitle.value,
    // filters
    notifyOnMention: notifyOnMention.value,
    notifyOnDM: notifyOnDM.value,
    notifyOnOther: notifyOnOther.value,
    muteSelfMessages: muteSelfMessages.value,
    mutedStreams: mutedStreams.value,
    mutedTopics: mutedTopics.value,
    // quiet hours
    quietHoursEnabled: quietHoursEnabled.value,
    quietHoursStart: quietHoursStart.value,
    quietHoursEnd: quietHoursEnd.value,
    // quiet days
    quietDaysEnabled: quietDaysEnabled.value,
    quietDays: quietDays.value,
    // privacy
    analyticsEnabled: analyticsEnabled.value,
    // developer
    devMode: devMode.value,
    useJSService: useJSService.value,
    // cloud push
    cloudPushEnabled: cloudPushEnabled.value,
    cloudPushUrl: cloudPushUrl.value
  })

  // sync filter changes to cloud pusher if enabled
  syncCloudPushFilters()
}

function addMutedStream() {
  const s = mutedStreamsInput.value.trim()
  if (s && !mutedStreams.value.includes(s)) {
    mutedStreams.value = [...mutedStreams.value, s]
    mutedStreamsInput.value = ''
    handleNotificationSettingChange()
  }
}

function removeMutedStream(stream: string) {
  mutedStreams.value = mutedStreams.value.filter(s => s !== stream)
  handleNotificationSettingChange()
}

function addMutedTopic() {
  const t = mutedTopicsInput.value.trim()
  if (t && !mutedTopics.value.includes(t)) {
    mutedTopics.value = [...mutedTopics.value, t]
    mutedTopicsInput.value = ''
    handleNotificationSettingChange()
  }
}

function removeMutedTopic(topic: string) {
  mutedTopics.value = mutedTopics.value.filter(t => t !== topic)
  handleNotificationSettingChange()
}

async function onChannelInputFocus() {
  showChannelSuggestions.value = true
  if (serverChannels.value.length === 0 && !loadingChannels.value) {
    loadingChannels.value = true
    try {
      const subs = await app.fetchSubscriptions()
      serverChannels.value = subs.map(s => ({ name: s.name, is_muted: s.is_muted }))
    } finally {
      loadingChannels.value = false
    }
  }
}

async function onTopicInputFocus() {
  showTopicSuggestions.value = true
  if (serverTopics.value.length === 0 && !loadingTopics.value) {
    loadingTopics.value = true
    try {
      serverTopics.value = await app.fetchAllTopics()
    } finally {
      loadingTopics.value = false
    }
  }
}

function addServerChannel(name: string) {
  if (!mutedStreams.value.includes(name)) {
    mutedStreams.value = [...mutedStreams.value, name]
    handleNotificationSettingChange()
  }
}

function addServerTopic(topic: string) {
  if (!mutedTopics.value.includes(topic)) {
    mutedTopics.value = [...mutedTopics.value, topic]
    handleNotificationSettingChange()
  }
}

async function handleSelectSound() {
  if (Capacitor.isNativePlatform()) {
    // use system ringtone picker on android
    const result = await pickNotificationSound(notificationSound.value || undefined)
    if (result) {
      notificationSound.value = result.uri || null
      notificationSoundTitle.value = result.title || null
      console.log('[sound] selected:', result.uri, result.title)
      handleNotificationSettingChange()
    }
  } else {
    // file picker for web
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'

    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return

      notificationSound.value = file.name
      notificationSoundTitle.value = file.name
      // pass file to browser notifications for audio playback
      if ('setCustomSound' in notifications) {
        (notifications as any).setCustomSound(file)
      }
      handleNotificationSettingChange()
    }
    input.click()
  }
}

async function clearCustomSound() {
  // clear web audio
  if ('setCustomSound' in notifications) {
    (notifications as any).setCustomSound(null)
  }
  notificationSound.value = null
  notificationSoundTitle.value = null
  handleNotificationSettingChange()
}

async function handlePickSoundFile() {
  const result = await pickSoundFile()
  if (result) {
    notificationSound.value = result.uri || null
    notificationSoundTitle.value = result.title || null
    console.log('[sound] picked file:', result.uri, result.title)
    handleNotificationSettingChange()
  }
}

function toggleQuietDay(day: number) {
  if (quietDays.value.includes(day)) {
    quietDays.value = quietDays.value.filter(d => d !== day)
  } else {
    quietDays.value = [...quietDays.value, day]
  }
  handleNotificationSettingChange()
}

const HUMMUS_URL = 'https://archive.org/download/hummus-slack/hummus-slack.mp3'

async function handleDownloadHummus() {
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await downloadAndSetSound(HUMMUS_URL, 'hummus.mp3')
      if (result) {
        notificationSound.value = result.uri || null
        notificationSoundTitle.value = result.title || 'Hummus'
        handleNotificationSettingChange()
      }
    } catch (err) {
      console.error('[hummus] download failed:', err)
    }
  } else {
    // web: fetch and set as blob
    try {
      const response = await fetch(HUMMUS_URL)
      const blob = await response.blob()
      const file = new File([blob], 'hummus.mp3', { type: 'audio/mpeg' })
      notificationSound.value = 'hummus.mp3'
      notificationSoundTitle.value = 'Hummus'
      if ('setCustomSound' in notifications) {
        (notifications as any).setCustomSound(file)
      }
      // play preview
      const audio = new Audio(URL.createObjectURL(blob))
      audio.play()
      handleNotificationSettingChange()
    } catch (err) {
      console.error('[hummus] download failed:', err)
    }
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
          <span>Instant notifications for DMs and @mentions</span>
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

    <!-- method selection screen (shown after first login) -->
    <div v-if="screen === 'method-select'" class="screen method-select-screen">
      <!-- back button -->
      <BackButton
        v-if="notificationMethodConfigured || pendingMethod || showPwaDialog"
        label="Back"
        class="top-back-btn"
        @click="pendingMethod ? cancelCloudConfirmation() : showPwaDialog ? (showPwaDialog = false) : (screen = 'connected')"
      />

      <header class="screen-header centered-header">
        <img src="/icon.svg" alt="" class="header-icon" />
        <h1>{{ notificationMethodConfigured ? 'Select delivery method' : 'Almost there!' }}</h1>
      </header>

      <!-- web push confirmation dialog (web) -->
      <div v-if="pendingMethod" class="cloud-confirm-dialog">
        <p class="confirm-title">Send credentials to server?</p>
        <p class="confirm-text">
          Web Push will send your Zulip API key to <strong>{{ cloudPushUrl || DEFAULT_PUSHER_URL }}</strong> so it can poll for messages and send you notifications.
        </p>
        <p class="confirm-text">Credentials are encrypted (AES-256), but you're trusting this server. For best security, use Foreground Service or host your own worker.</p>

        <div class="confirm-custom-url">
          <label>Worker URL (optional)</label>
          <input type="url" v-model="cloudPushUrl" :placeholder="DEFAULT_PUSHER_URL">
          <SelfHostLink />
        </div>

        <button class="primary confirm-continue-btn" :disabled="isConfirming" @click="confirmCloudMethod">
          {{ isConfirming ? 'Connecting...' : 'I understand, continue' }}
        </button>
      </div>

      <!-- pwa required dialog (android) -->
      <div v-if="showPwaDialog" class="cloud-confirm-dialog">
        <p class="confirm-title">PWA required</p>
        <p class="confirm-text">
          Web Push on Android requires installing the PWA (Progressive Web App) from your browser.
        </p>
        <p class="confirm-text">Open the web app in Chrome, tap the menu, and select "Add to Home Screen". The PWA uses less battery than Foreground Service.</p>

        <div class="confirm-buttons">
          <button class="secondary" @click="showPwaDialog = false">Cancel</button>
          <button class="primary" @click="openPwaInBrowser">Open Web App</button>
        </div>
      </div>

      <!-- loading state while connecting -->
      <div v-if="isConfirming" class="connecting-state">
        <div class="spinner"></div>
        <p>Connecting to push server...</p>
      </div>

      <!-- method selector (hidden during confirmation/loading) -->
      <NotificationMethodSelector
        v-if="!pendingMethod && !showPwaDialog && !isConfirming"
        @select="handleMethodSelect"
      />
    </div>

    <!-- connected screen -->
    <div v-if="screen === 'connected'" class="screen connected">
      <header class="navbar">
        <div class="navbar-brand" @click="handleDevTap">
          <img src="/icon.svg" alt="" class="navbar-icon" />
          <span>Zulip Notifications</span>
        </div>
      </header>

      <Toast :message="devTapMessage" />

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
        <!-- delivery method section -->
        <div class="settings-section">
          <h3>Delivery Method</h3>

          <div class="current-method">
            <span class="current-method-name">{{ methodDisplayName }}</span>
            <button class="small-btn" @click="screen = 'method-select'">Change</button>
          </div>

          <!-- web push settings -->
          <div v-if="notificationMethod === 'web-push'" class="cloud-push-inline">
            <div class="cloud-push-url-inline">
              <label>Worker URL</label>
              <div class="url-input-row">
                <input
                  type="url"
                  v-model="cloudPushUrl"
                  :placeholder="DEFAULT_PUSHER_URL"
                >
                <button class="small-btn" @click="saveWorkerUrl">Save</button>
              </div>
              <SelfHostLink />
            </div>

            <div v-if="cloudPushError" class="cloud-push-error">{{ cloudPushError }}</div>

            <div v-if="cloudPushStatus !== 'idle'" class="cloud-push-status">
              <span class="status-dot" :class="cloudPushStatus"></span>
              <span>{{ cloudPushStatusText }}</span>
            </div>

            <div v-if="cloudPushStatus === 'registered'" class="test-buttons">
              <button class="test-push-btn" @click="sendLocalTestNotification">Local test</button>
              <button class="test-push-btn" @click="sendTestPush">Cloud test</button>
            </div>
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-section">
          <h3>Notifications</h3>

          <label class="checkbox-field">
            <input type="checkbox" v-model="playSounds" @change="handleNotificationSettingChange">
            <span>Play notification sounds</span>
          </label>

          <label class="checkbox-field">
            <input type="checkbox" v-model="groupByConversation" @change="handleNotificationSettingChange">
            <span>Group by conversation</span>
          </label>
          <small class="setting-hint">Stack messages from same sender/topic</small>

          <label class="checkbox-field">
            <input type="checkbox" v-model="showTimestamps" @change="handleNotificationSettingChange">
            <span>Show timestamps</span>
          </label>
          <small class="setting-hint">Display time in notification messages</small>

          <label class="checkbox-field">
            <input type="checkbox" v-model="vibrate" @change="handleNotificationSettingChange">
            <span>Vibrate</span>
          </label>

          <label class="checkbox-field">
            <input type="checkbox" v-model="openZulipApp" @change="handleNotificationSettingChange">
            <span>Open Zulip app when tapped</span>
          </label>
          <small class="setting-hint">Otherwise opens this app</small>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-section">
          <h3>Filters</h3>

          <label class="checkbox-field">
            <input type="checkbox" v-model="notifyOnMention" @change="handleNotificationSettingChange">
            <span>Notify on @mention</span>
          </label>

          <label class="checkbox-field">
            <input type="checkbox" v-model="notifyOnDM" @change="handleNotificationSettingChange">
            <span>Notify on DM</span>
          </label>

          <label class="checkbox-field">
            <input type="checkbox" v-model="notifyOnOther" @change="handleNotificationSettingChange">
            <span>Notify on other messages</span>
          </label>
          <small class="setting-hint">Channel messages without @mention</small>

          <label class="checkbox-field">
            <input type="checkbox" v-model="muteSelfMessages" @change="handleNotificationSettingChange">
            <span>Mute self messages</span>
          </label>
          <small class="setting-hint">Don't notify on your own messages</small>

          <div class="sound-setting">
            <span class="sound-label">Notification sound</span>
            <div class="sound-controls">
              <button class="small-btn" @click="handleSelectSound">
                {{ soundDisplayName }}
              </button>
              <button v-if="notificationSound" class="small-btn danger-text" @click="clearCustomSound">
                Reset
              </button>
            </div>
          </div>
          <button class="small-btn import-btn" v-if="isNativePlatform" @click="handlePickSoundFile">
            + Pick custom file
          </button>
          <button class="small-btn hummus-btn" @click="handleDownloadHummus">
            Hummus.
          </button>
          <small v-if="isNativePlatform" class="setting-hint">Select any audio file from storage</small>
          <small v-else class="setting-hint">Custom sounds only work while the tab is open</small>

          <div class="mute-list">
            <span class="mute-label">Muted channels</span>
            <small class="setting-hint">Zulip streams/channels to ignore</small>
            <div class="mute-input-wrapper">
              <div class="mute-input-row">
                <input
                  v-model="mutedStreamsInput"
                  type="text"
                  placeholder="channel name"
                  @keyup.enter="addMutedStream"
                  @focus="onChannelInputFocus"
                  @blur="showChannelSuggestions = false"
                >
                <button class="small-btn" @click="addMutedStream">Add</button>
              </div>
              <div v-if="showChannelSuggestions && (serverChannels.length || loadingChannels)" class="suggestions-dropdown">
                <small v-if="loadingChannels" class="suggestion-loading">Loading...</small>
                <div v-else class="suggestion-tags">
                  <span
                    v-for="c in serverChannels"
                    :key="c.name"
                    class="suggestion-tag"
                    :class="{ muted: c.is_muted, added: mutedStreams.includes(c.name) }"
                    @mousedown.prevent="addServerChannel(c.name)"
                  >
                    {{ c.name }}{{ c.is_muted ? ' (muted)' : '' }}
                  </span>
                </div>
              </div>
            </div>
            <div v-if="mutedStreams.length" class="mute-tags">
              <span v-for="s in mutedStreams" :key="s" class="mute-tag" @click="removeMutedStream(s)">
                {{ s }} ×
              </span>
            </div>
          </div>

          <div class="mute-list">
            <span class="mute-label">Muted topics</span>
            <small class="setting-hint">Text or regex pattern to match topics</small>
            <div class="mute-input-wrapper">
              <div class="mute-input-row">
                <input
                  v-model="mutedTopicsInput"
                  type="text"
                  placeholder="topic name or regex"
                  @keyup.enter="addMutedTopic"
                  @focus="onTopicInputFocus"
                  @blur="showTopicSuggestions = false"
                >
                <button class="small-btn" @click="addMutedTopic">Add</button>
              </div>
              <div v-if="showTopicSuggestions && (serverTopics.length || loadingTopics)" class="suggestions-dropdown">
                <small v-if="loadingTopics" class="suggestion-loading">Loading...</small>
                <div v-else class="suggestion-tags">
                  <span
                    v-for="t in serverTopics"
                    :key="`${t.stream_name}/${t.topic}`"
                    class="suggestion-tag"
                    :class="{ added: mutedTopics.includes(t.topic) }"
                    @mousedown.prevent="addServerTopic(t.topic)"
                  >
                    {{ t.stream_name }}/{{ t.topic }}
                  </span>
                </div>
              </div>
            </div>
            <div v-if="mutedTopics.length" class="mute-tags">
              <span v-for="t in mutedTopics" :key="t" class="mute-tag" @click="removeMutedTopic(t)">
                {{ t }} ×
              </span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Quiet Hours</h3>

          <label class="checkbox-field">
            <input type="checkbox" v-model="quietHoursEnabled" @change="handleNotificationSettingChange">
            <span>Enable quiet hours</span>
          </label>
          <small class="setting-hint">No notifications during this time</small>

          <div v-if="quietHoursEnabled" class="quiet-hours-inputs">
            <div class="time-input">
              <label>From</label>
              <input type="time" v-model="quietHoursStart" @change="handleNotificationSettingChange">
            </div>
            <div class="time-input">
              <label>To</label>
              <input type="time" v-model="quietHoursEnd" @change="handleNotificationSettingChange">
            </div>
          </div>

          <label class="checkbox-field" style="margin-top: 16px;">
            <input type="checkbox" v-model="quietDaysEnabled" @change="handleNotificationSettingChange">
            <span>Enable quiet days</span>
          </label>
          <small class="setting-hint">No notifications on selected days</small>

          <div v-if="quietDaysEnabled" class="quiet-days-selector">
            <button
              v-for="wd in weekdays"
              :key="wd.day"
              type="button"
              class="day-btn"
              :class="{ active: quietDays.includes(wd.day) }"
              @click="toggleQuietDay(wd.day)"
            >
              {{ wd.label }}
            </button>
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-section">
          <h3>Privacy</h3>

          <label class="checkbox-field">
            <input type="checkbox" v-model="analyticsEnabled" @change="handleNotificationSettingChange">
            <span>Anonymous public stats collection</span>
          </label>
          <small class="setting-hint">Helps improve the app. No personal data collected. <a href="https://stats.faeller.me" target="_blank" class="stats-link">View stats</a></small>
        </div>

        <!-- developer options (hidden until enabled by tapping icon 8x) -->
        <template v-if="devMode">
          <div class="settings-divider"></div>

          <div class="settings-section">
            <h3>Developer Options</h3>

            <label class="checkbox-field">
              <input type="checkbox" v-model="useJSService" @change="handleServiceChange" :disabled="!isNativePlatform">
              <span>Use Rhino JS polling service</span>
            </label>
            <small class="setting-hint">
              {{ isNativePlatform ? 'Uses shared JS logic via Rhino engine. Requires service restart.' : 'Only available on Android.' }}
            </small>

            <button class="dev-btn" @click="devMode = false; handleNotificationSettingChange()">
              Disable developer mode
            </button>
          </div>
        </template>
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
