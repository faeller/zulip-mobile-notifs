import type { ZulipCredentials, AppState, MessageEvent, AnyZulipEvent, ZulipMessage, ZulipUser, AppSettings } from './types.ts'
import { DEFAULT_SETTINGS } from './types.ts'
import { ZulipClient } from './zulip-client.ts'
import { storage } from './storage.ts'
import { notifications } from './notifications.ts'

const CREDENTIALS_KEY = 'credentials'
const SETTINGS_KEY = 'settings'

type StateListener = (state: AppState) => void

// main app orchestrator - handles connection lifecycle and event processing
export class App {
  private client: ZulipClient | null = null
  private state: AppState = {
    credentials: null,
    connectionState: 'disconnected',
    lastEventTime: null,
    error: null,
    userId: null,
    userEmail: null,
    settings: { ...DEFAULT_SETTINGS }
  }
  private listeners: StateListener[] = []
  private pollLoopActive = false

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

  // load saved credentials and settings on startup
  async init(): Promise<void> {
    console.log('[app] initializing...')

    const savedCreds = await storage.get<ZulipCredentials>(CREDENTIALS_KEY)
    if (savedCreds) {
      console.log('[app] found saved credentials for', savedCreds.email)
      this.setState({ credentials: savedCreds })
    } else {
      console.log('[app] no saved credentials')
    }

    const savedSettings = await storage.get<AppSettings>(SETTINGS_KEY)
    if (savedSettings) {
      console.log('[app] loaded settings:', savedSettings)
      this.setState({ settings: { ...DEFAULT_SETTINGS, ...savedSettings } })
    }
  }

  // update settings
  async setSettings(settings: Partial<AppSettings>): Promise<void> {
    const newSettings = { ...this.state.settings, ...settings }
    console.log('[app] updating settings:', newSettings)
    await storage.set(SETTINGS_KEY, newSettings)
    this.setState({ settings: newSettings })
  }

  // save and set new credentials
  async setCredentials(creds: ZulipCredentials): Promise<void> {
    console.log('[app] saving credentials for', creds.email)
    await storage.set(CREDENTIALS_KEY, creds)
    this.setState({ credentials: creds, error: null })
  }

  // clear stored credentials
  async clearCredentials(): Promise<void> {
    console.log('[app] clearing credentials')
    await this.disconnect()
    await storage.remove(CREDENTIALS_KEY)
    this.setState({ credentials: null, userId: null, userEmail: null })
  }

  // connect to zulip and start event loop
  async connect(): Promise<void> {
    if (!this.state.credentials) {
      console.error('[app] connect called without credentials')
      this.setState({ error: 'No credentials configured' })
      return
    }

    console.log('[app] connecting to', this.state.credentials.serverUrl)
    this.setState({ connectionState: 'connecting', error: null })

    try {
      this.client = new ZulipClient(this.state.credentials)

      // test auth first
      console.log('[app] testing authentication...')
      const user = await this.client.testConnection()
      console.log('[app] authenticated as', user.full_name, `(id: ${user.user_id})`)
      this.setState({ userId: user.user_id, userEmail: user.email })

      // request notification permission
      const granted = await notifications.requestPermission()
      console.log('[app] notification permission:', granted ? 'granted' : 'denied')

      // register event queue
      console.log('[app] registering event queue...')
      await this.client.registerQueue()
      console.log('[app] event queue registered, starting poll loop')

      this.setState({ connectionState: 'connected', lastEventTime: Date.now() })

      // start polling loop
      this.startPollLoop()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      console.error('[app] connection failed:', msg)
      this.setState({ connectionState: 'error', error: msg })
      this.client = null
    }
  }

  // disconnect and cleanup
  async disconnect(): Promise<void> {
    console.log('[app] disconnecting...')
    this.pollLoopActive = false

    if (this.client) {
      await this.client.disconnect()
      this.client = null
    }

    console.log('[app] disconnected')
    this.setState({ connectionState: 'disconnected', error: null })
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

  // determine if message should trigger notification
  // decision logic:
  //   - PMs (direct messages): always notify
  //   - stream messages: only if @-mentioned or wildcard (@all, @everyone)
  //   - own messages: never notify
  private shouldNotify(msg: ZulipMessage, flags: string[]): boolean {
    // always notify on PMs
    if (msg.type === 'private') {
      console.log('[notify] PM detected -> will notify')
      return true
    }

    // notify if mentioned
    if (flags.includes('mentioned')) {
      console.log('[notify] direct @-mention detected -> will notify')
      return true
    }
    if (flags.includes('wildcard_mentioned')) {
      console.log('[notify] wildcard mention (@all etc) -> will notify')
      return true
    }

    console.log('[notify] stream message without mention -> skip')
    return false
  }

  // format notification content from message
  private formatNotification(msg: ZulipMessage): { title: string; body: string } {
    const sender = msg.sender_full_name

    if (msg.type === 'private') {
      // for group PMs, show all recipients
      const recipients = Array.isArray(msg.display_recipient)
        ? (msg.display_recipient as ZulipUser[])
            .filter(u => u.user_id !== this.state.userId)
            .map(u => u.full_name)
            .join(', ')
        : sender

      return {
        title: `PM from ${recipients.length > 30 ? sender : recipients}`,
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

    // TODO: uncomment after testing
    // // don't notify on own messages
    // if (msg.sender_id === this.state.userId) {
    //   console.log('[message] from self, skipping')
    //   return
    // }

    // check if we should notify
    if (!this.shouldNotify(msg, flags)) {
      return
    }

    const { title, body } = this.formatNotification(msg)
    console.log('[message] showing notification:', { title, body })

    // tag by sender to avoid duplicate notification spam
    notifications.showNotification(title, body, `msg-${msg.sender_id}`)
  }

  // expose current state for UI
  getState(): AppState {
    return this.state
  }
}

// singleton
export const app = new App()
