import type { ZulipCredentials, AppState, MessageEvent, AnyZulipEvent, ZulipMessage, ZulipUser, AppSettings } from './types.ts'
import { DEFAULT_SETTINGS, getAccountId } from './types.ts'
import { ZulipClient } from './zulip-client.ts'
import { storage } from './storage.ts'
import { notifications } from './notifications.ts'
import { startForegroundService, stopForegroundService } from './foreground-service.ts'
import { Capacitor } from '@capacitor/core'

// anonymous analytics (proxied through CF worker, no PII)
const ANALYTICS_URL = 'https://stats.faeller.me'
let analyticsEnabled = true // will be updated from settings

function trackEvent(event: string, meta?: Record<string, string>) {
  if (!analyticsEnabled) return
  const platform = Capacitor.isNativePlatform() ? 'android' : 'web'
  fetch(ANALYTICS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, meta: { version: __APP_VERSION__, platform, ...meta } })
  }).catch(() => {}) // silent fail
}

const ACCOUNTS_KEY = 'accounts'  // array of saved accounts
const SETTINGS_KEY = 'settings'
const LAST_ACTIVE_KEY = 'lastActive'  // account id of last connected account
const LAST_NOTIFIED_KEY = 'lastNotifiedMsgId'  // last message id we notified about
const INSTALL_TRACKED_KEY = 'installTracked'  // whether we've tracked install

type StateListener = (state: AppState) => void

// main app orchestrator - handles connection lifecycle and event processing
export class App {
  private client: ZulipClient | null = null
  private state: AppState = {
    savedAccounts: [],
    activeAccount: null,
    connectionState: 'disconnected',
    lastEventTime: null,
    error: null,
    userId: null,
    userEmail: null,
    settings: { ...DEFAULT_SETTINGS }
  }
  private listeners: StateListener[] = []
  private pollLoopActive = false
  private lastNotifiedMsgId: number = 0

  // subscribe to state changes
  onStateChange(listener: StateListener): () => void {
    this.listeners.push(listener)
    listener(this.state) // immediate callback with current state
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private setState(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial }
    this.listeners.forEach(l => l(this.state))
  }

  // load saved accounts and settings on startup, auto-connect if last active
  async init(): Promise<void> {
    console.log('[app] initializing...')

    // load settings first (needed for analytics check)
    const savedSettings = await storage.get<AppSettings>(SETTINGS_KEY)
    if (savedSettings) {
      console.log('[app] loaded settings:', savedSettings)
      this.setState({ settings: { ...DEFAULT_SETTINGS, ...savedSettings } })
      analyticsEnabled = savedSettings.analyticsEnabled ?? true
    }

    // track install once, then app_open
    const installTracked = await storage.get<boolean>(INSTALL_TRACKED_KEY)
    if (!installTracked) {
      trackEvent('install')
      await storage.set(INSTALL_TRACKED_KEY, true)
    }
    trackEvent('app_open')

    const savedAccounts = await storage.get<ZulipCredentials[]>(ACCOUNTS_KEY)
    if (savedAccounts && savedAccounts.length > 0) {
      console.log('[app] found', savedAccounts.length, 'saved account(s)')
      this.setState({ savedAccounts })
    } else {
      console.log('[app] no saved accounts')
    }

    // load last notified message id
    const lastNotified = await storage.get<number>(LAST_NOTIFIED_KEY)
    if (lastNotified) {
      this.lastNotifiedMsgId = lastNotified
      console.log('[app] last notified msg id:', lastNotified)
    }

    // auto-connect to last active account
    const lastActiveId = await storage.get<string>(LAST_ACTIVE_KEY)
    if (lastActiveId && savedAccounts) {
      const account = savedAccounts.find(a => getAccountId(a) === lastActiveId)
      if (account) {
        console.log('[app] auto-connecting to last active account:', account.email)
        this.connect(account)
      }
    }
  }

  // update settings
  async setSettings(settings: Partial<AppSettings>): Promise<void> {
    const newSettings = { ...this.state.settings, ...settings }
    console.log('[app] updating settings:', newSettings)
    await storage.set(SETTINGS_KEY, newSettings)
    this.setState({ settings: newSettings })

    // update analytics flag
    if (settings.analyticsEnabled !== undefined) {
      analyticsEnabled = settings.analyticsEnabled
    }

    // if keepalive changed and we're connected, restart poll with new timeout
    if (settings.keepaliveSec !== undefined && this.client?.isConnected()) {
      console.log('[app] keepalive changed, restarting poll')
      this.client.abortCurrentPoll()
    }

    // restart native service if notification settings changed (for new channel)
    if (Capacitor.isNativePlatform() && this.state.connectionState === 'connected') {
      const notifSettingsChanged = settings.notificationSound !== undefined ||
        settings.playSounds !== undefined ||
        settings.groupByConversation !== undefined ||
        settings.vibrate !== undefined ||
        settings.openZulipApp !== undefined

      if (notifSettingsChanged) {
        console.log('[app] notification settings changed, restarting service')
        await stopForegroundService()
        await startForegroundService()
      }
    }
  }

  // save account (adds or updates existing)
  async saveAccount(creds: ZulipCredentials): Promise<void> {
    const id = getAccountId(creds)
    const existing = this.state.savedAccounts.findIndex(a => getAccountId(a) === id)

    let newAccounts: ZulipCredentials[]
    if (existing >= 0) {
      // update existing account
      console.log('[app] updating account for', creds.email)
      newAccounts = [...this.state.savedAccounts]
      newAccounts[existing] = creds
    } else {
      // add new account
      console.log('[app] saving new account for', creds.email)
      newAccounts = [...this.state.savedAccounts, creds]
    }

    await storage.set(ACCOUNTS_KEY, newAccounts)
    this.setState({ savedAccounts: newAccounts, error: null })
  }

  // remove a specific account
  async removeAccount(creds: ZulipCredentials): Promise<void> {
    const id = getAccountId(creds)
    console.log('[app] removing account for', creds.email)

    // disconnect if this is the active account
    if (this.state.activeAccount && getAccountId(this.state.activeAccount) === id) {
      await this.disconnect()
    }

    const newAccounts = this.state.savedAccounts.filter(a => getAccountId(a) !== id)
    await storage.set(ACCOUNTS_KEY, newAccounts)
    this.setState({ savedAccounts: newAccounts })
  }

  // clear all stored accounts
  async clearAllAccounts(): Promise<void> {
    console.log('[app] clearing all accounts')
    await this.disconnect()
    await storage.remove(ACCOUNTS_KEY)
    this.setState({ savedAccounts: [], activeAccount: null, userId: null, userEmail: null })
  }

  // connect to zulip and start event loop
  // if saveOnSuccess is true, saves the account after successful connection
  async connect(creds: ZulipCredentials, saveOnSuccess: boolean = false): Promise<void> {
    if (!creds) {
      console.error('[app] connect called without credentials')
      this.setState({ error: 'No credentials configured' })
      return
    }

    console.log('[app] connecting to', creds.serverUrl)
    this.setState({ connectionState: 'connecting', error: null, activeAccount: creds })

    try {
      this.client = new ZulipClient(creds)

      // test auth first
      console.log('[app] testing authentication...')
      const user = await this.client.testConnection()
      console.log('[app] authenticated as', user.full_name, `(id: ${user.user_id})`)
      this.setState({ userId: user.user_id, userEmail: user.email })

      // request notification permission
      const granted = await notifications.requestPermission()
      console.log('[app] notification permission:', granted ? 'granted' : 'denied')

      // on native, the foreground service handles queue registration and polling
      // on web, we need to register the queue here
      if (!Capacitor.isNativePlatform()) {
        console.log('[app] registering event queue...')
        await this.client.registerQueue()
        console.log('[app] event queue registered')
      }

      this.setState({ connectionState: 'connected', lastEventTime: Date.now() })
      trackEvent('connect', { auth: creds.authMethod || 'unknown' })

      // remember last active account for auto-reconnect
      await storage.set(LAST_ACTIVE_KEY, getAccountId(creds))

      // save account only after successful connection
      if (saveOnSuccess) {
        await this.saveAccount(creds)
      }

      // on native, let the foreground service handle polling and notifications
      // on web, we need to run the JS poll loop
      if (Capacitor.isNativePlatform()) {
        console.log('[app] native platform, delegating polling to foreground service')
        await startForegroundService()
      } else {
        console.log('[app] web platform, starting JS poll loop')
        // catch up on missed messages
        await this.catchUpUnreadMessages()
        // start polling loop
        this.startPollLoop()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      console.error('[app] connection failed:', msg)
      this.setState({ connectionState: 'error', error: msg, activeAccount: null })
      this.client = null
    }
  }

  // disconnect and cleanup
  async disconnect(): Promise<void> {
    console.log('[app] disconnecting...')
    this.pollLoopActive = false

    // clear last active so we don't auto-reconnect
    await storage.remove(LAST_ACTIVE_KEY)

    // stop foreground service
    await stopForegroundService()

    if (this.client) {
      await this.client.disconnect()
      this.client = null
    }

    console.log('[app] disconnected')
    this.setState({ connectionState: 'disconnected', error: null, activeAccount: null })
  }

  // continuous event polling
  private async startPollLoop(): Promise<void> {
    if (this.pollLoopActive) {
      console.log('[poll] loop already active, skipping')
      return
    }
    this.pollLoopActive = true
    console.log('[poll] starting poll loop')

    while (this.pollLoopActive && this.client?.isConnected()) {
      try {
        const timeoutMs = this.state.settings.keepaliveSec * 1000
        console.log(`[poll] waiting for events (keepalive: ${this.state.settings.keepaliveSec}s)...`)
        const events = await this.client.getEvents(timeoutMs)
        console.log(`[poll] received ${events.length} event(s)`)
        this.setState({ lastEventTime: Date.now() })
        this.processEvents(events)
      } catch (err) {
        // handle queue expiration - need to re-register
        if (err instanceof Error && err.message.includes('BAD_EVENT_QUEUE_ID')) {
          console.warn('[poll] queue expired, re-registering...')
          try {
            await this.client.registerQueue()
            console.log('[poll] re-registered successfully')
          } catch (regErr) {
            console.error('[poll] re-registration failed:', regErr)
            this.setState({
              connectionState: 'error',
              error: 'Failed to re-register event queue'
            })
            break
          }
        } else {
          console.error('[poll] error:', err)
          // brief backoff on errors
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
    console.log('[poll] loop ended')
  }

  // handle incoming events
  private processEvents(events: AnyZulipEvent[]): void {
    for (const event of events) {
      console.log(`[event] type=${event.type}, id=${event.id}`)
      if (event.type === 'message') {
        this.handleMessage(event as MessageEvent)
      } else if (event.type === 'heartbeat') {
        console.log('[event] heartbeat (keepalive)')
      } else {
        console.log('[event] unhandled event type:', event.type)
      }
    }
  }

  // check if current time is within quiet hours
  private isQuietHours(): boolean {
    if (!this.state.settings.quietHoursEnabled) return false

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    const [startH, startM] = this.state.settings.quietHoursStart.split(':').map(Number)
    const [endH, endM] = this.state.settings.quietHoursEnd.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    // handle overnight quiet hours (e.g., 22:00 to 07:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }

  // determine if message should trigger notification based on settings
  private shouldNotify(msg: ZulipMessage, flags: string[]): boolean {
    const settings = this.state.settings

    // skip own messages
    if (settings.muteSelfMessages && msg.sender_id === this.state.userId) {
      console.log('[notify] own message, skipping')
      return false
    }

    // check quiet hours
    if (this.isQuietHours()) {
      console.log('[notify] quiet hours active, skipping')
      return false
    }

    const isDM = msg.type === 'private'
    const isMention = flags.includes('mentioned') || flags.includes('wildcard_mentioned')

    // DM handling
    if (isDM) {
      if (!settings.notifyOnDM) {
        console.log('[notify] DM notifications disabled, skipping')
        return false
      }
      console.log('[notify] DM detected -> will notify')
      return true
    }

    // stream message handling
    if (isMention && !settings.notifyOnMention) {
      console.log('[notify] mention notifications disabled, skipping')
      return false
    }
    if (!isMention && !settings.notifyOnOther) {
      console.log('[notify] other channel notifications disabled, skipping')
      return false
    }

    // check muted channels
    const streamName = typeof msg.display_recipient === 'string' ? msg.display_recipient : null
    if (streamName && settings.mutedStreams.length > 0) {
      const isMuted = settings.mutedStreams.some(
        muted => muted.toLowerCase() === streamName.toLowerCase()
      )
      if (isMuted) {
        console.log('[notify] channel is muted, skipping')
        return false
      }
    }

    // check muted topics (regex patterns)
    if (msg.subject && settings.mutedTopics.length > 0) {
      for (const pattern of settings.mutedTopics) {
        try {
          const regex = new RegExp(pattern, 'i')
          if (regex.test(msg.subject)) {
            console.log('[notify] topic matches muted pattern, skipping')
            return false
          }
        } catch {
          // fallback to simple contains check if regex invalid
          if (msg.subject.toLowerCase().includes(pattern.toLowerCase())) {
            console.log('[notify] topic contains muted string, skipping')
            return false
          }
        }
      }
    }

    console.log('[notify] passed all filters -> will notify')
    return true
  }

  // format notification content from message
  private formatNotification(msg: ZulipMessage): { title: string; body: string } {
    const sender = msg.sender_full_name

    if (msg.type === 'private') {
      // for group DMs, show all recipients
      const recipients = Array.isArray(msg.display_recipient)
        ? (msg.display_recipient as ZulipUser[])
            .filter(u => u.user_id !== this.state.userId)
            .map(u => u.full_name)
            .join(', ')
        : sender

      return {
        title: `DM from ${recipients.length > 30 ? sender : recipients}`,
        body: this.stripHtml(msg.content).slice(0, 200)
      }
    }

    // stream message with mention
    const stream = typeof msg.display_recipient === 'string' ? msg.display_recipient : 'unknown'
    return {
      title: `${sender} in #${stream} > ${msg.subject}`,
      body: this.stripHtml(msg.content).slice(0, 200)
    }
  }

  // basic html stripping for notification body
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // process single message event
  private handleMessage(event: MessageEvent): void {
    const msg = event.message
    const flags = event.flags || []

    console.log('[message] received:', {
      id: msg.id,
      type: msg.type,
      sender: msg.sender_full_name,
      sender_id: msg.sender_id,
      subject: msg.subject,
      flags: flags,
      content_preview: msg.content.slice(0, 100)
    })

    // check if we should notify
    if (!this.shouldNotify(msg, flags)) {
      return
    }

    const { title, body } = this.formatNotification(msg)
    console.log('[message] showing notification:', { title, body })

    // tag by sender to avoid duplicate notification spam
    notifications.showNotification(title, body, `msg-${msg.sender_id}`, {
      silent: !this.state.settings.playSounds
    })

    // track last notified message id
    if (msg.id > this.lastNotifiedMsgId) {
      this.lastNotifiedMsgId = msg.id
      storage.set(LAST_NOTIFIED_KEY, msg.id)
    }
  }

  // fetch unread messages and notify about any we missed
  private async catchUpUnreadMessages(): Promise<void> {
    if (!this.client) return

    try {
      console.log('[catch-up] fetching unread messages...')
      const unreads = await this.client.getUnreadMessages()

      // filter to only messages newer than last notified
      const newUnreads = unreads.filter(m => m.id > this.lastNotifiedMsgId)
      console.log('[catch-up] found', newUnreads.length, 'new unread messages')

      if (newUnreads.length === 0) return

      // batch into single notification if multiple
      if (newUnreads.length > 1) {
        const title = `${newUnreads.length} missed messages`
        const body = newUnreads
          .slice(0, 5)
          .map(m => `${m.sender_full_name}: ${this.stripHtml(m.content).slice(0, 50)}`)
          .join('\n')
        notifications.showNotification(title, body, 'catch-up', {
          silent: !this.state.settings.playSounds
        })
      } else {
        const m = newUnreads[0]
        const title = m.type === 'private'
          ? `DM from ${m.sender_full_name}`
          : `${m.sender_full_name} mentioned you`
        notifications.showNotification(title, this.stripHtml(m.content).slice(0, 200), 'catch-up', {
          silent: !this.state.settings.playSounds
        })
      }

      // update last notified to newest
      const maxId = Math.max(...newUnreads.map(m => m.id))
      this.lastNotifiedMsgId = maxId
      await storage.set(LAST_NOTIFIED_KEY, maxId)
    } catch (err) {
      console.warn('[catch-up] failed to fetch unreads:', err)
    }
  }

  // fetch subscribed channels from server
  async fetchSubscriptions(): Promise<{ name: string; stream_id: number; is_muted: boolean }[]> {
    if (!this.client) return []
    try {
      return await this.client.getSubscriptions()
    } catch (err) {
      console.error('[app] failed to fetch subscriptions:', err)
      return []
    }
  }

  // fetch all topics from subscribed channels
  async fetchAllTopics(): Promise<{ stream_name: string; topic: string }[]> {
    if (!this.client) return []
    try {
      return await this.client.getAllTopics()
    } catch (err) {
      console.error('[app] failed to fetch topics:', err)
      return []
    }
  }

  // expose current state for UI
  getState(): AppState {
    return this.state
  }
}

// singleton
export const app = new App()
