// zulip api types

// cloud pusher URL - single source of truth
// self-host: https://github.com/faeller/zulip-mobile-notifs/tree/main/worker
export const DEFAULT_PUSHER_URL = 'https://cf-zulip-web-pusher.faeller.me'

// notification delivery methods
export type NotificationMethod =
  | 'web-push'            // web: polls when tab open, cloud push when closed (via CF worker)
  | 'foreground-service'  // android: native polling (instant, creds on device)
  | 'tab-only'            // web: only works when tab is open (no cloud, fully private)
  | 'unified-push'        // android: via UnifiedPush (future)
  | 'long-poll-server'    // self-hosted long-poll server (future)

export type AuthMethod = 'password' | 'sso' | 'zuliprc' | 'manual'

export interface ZulipCredentials {
  serverUrl: string
  email: string
  apiKey: string
  authMethod?: AuthMethod  // how the credentials were obtained
  notificationMethod?: NotificationMethod  // per-account delivery method
  cloudPushUrl?: string  // custom worker URL (if using cloud push)
}

// unique identifier for an account (server + email combo)
export function getAccountId(creds: ZulipCredentials): string {
  return `${creds.serverUrl}::${creds.email}`
}

export interface ZulipUser {
  user_id: number
  email: string
  full_name: string
}

// message types from zulip api
export interface ZulipMessage {
  id: number
  sender_id: number
  sender_email: string
  sender_full_name: string
  content: string
  content_type: string
  subject: string // topic name for stream messages
  type: 'stream' | 'private'
  display_recipient: string | ZulipUser[] // stream name or list of recipients
  timestamp: number
  flags: string[]
  stream_id?: number
}

// event queue registration response
export interface RegisterResponse {
  queue_id: string
  last_event_id: number
  zulip_version: string
  zulip_feature_level: number
}

// events from long-polling
export interface ZulipEvent {
  id: number
  type: string
}

export interface MessageEvent extends ZulipEvent {
  type: 'message'
  message: ZulipMessage
  flags: string[]
}

export interface HeartbeatEvent extends ZulipEvent {
  type: 'heartbeat'
}

export type AnyZulipEvent = MessageEvent | HeartbeatEvent | ZulipEvent

// app settings (persisted)
export interface AppSettings {
  keepaliveSec: number // long-poll keepalive interval in seconds
  // notification method
  notificationMethod: NotificationMethod | null // null = not yet chosen
  notificationMethodConfigured: boolean // true after user has made initial choice
  // notification settings
  playSounds: boolean // play notification sounds
  groupByConversation: boolean // true = stack msgs per conversation, false = separate notifs
  vibrate: boolean // vibrate on notification
  openZulipApp: boolean // true = open zulip mobile app, false = open our app
  showTimestamps: boolean // show time in notification messages
  notificationSound: string | null // custom sound uri, null = default
  notificationSoundTitle: string | null // display name for custom sound
  // notification filters
  notifyOnMention: boolean // notify on @-mentions
  notifyOnDM: boolean // notify on direct messages
  notifyOnOther: boolean // notify on other stream messages
  muteSelfMessages: boolean // don't notify on your own messages
  mutedStreams: string[] // stream names to exclude
  mutedTopics: string[] // topic patterns to exclude
  // quiet hours
  quietHoursEnabled: boolean
  quietHoursStart: string // HH:MM format
  quietHoursEnd: string // HH:MM format
  // quiet days (0=sunday, 1=monday, ..., 6=saturday)
  quietDaysEnabled: boolean
  quietDays: number[]
  // privacy
  analyticsEnabled: boolean // send anonymous usage stats
  // developer options (hidden until activated)
  devMode: boolean // show developer settings
  useJSService: boolean // use rhino-based JSPollingService instead of native
  // cloud push (web only)
  cloudPushEnabled: boolean
  cloudPushUrl: string // pusher server URL
}

export const DEFAULT_SETTINGS: AppSettings = {
  keepaliveSec: 90,
  notificationMethod: null,
  notificationMethodConfigured: false,
  playSounds: true,
  groupByConversation: true,
  vibrate: true,
  openZulipApp: true,
  showTimestamps: false,
  notificationSound: null,
  notificationSoundTitle: null,
  // filters
  notifyOnMention: true,
  notifyOnDM: true,
  notifyOnOther: true,
  muteSelfMessages: true,
  mutedStreams: [],
  mutedTopics: [],
  // quiet hours
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  // quiet days
  quietDaysEnabled: false,
  quietDays: [],
  // privacy
  analyticsEnabled: true,
  // developer options
  devMode: false,
  useJSService: false,
  // cloud push
  cloudPushEnabled: false,
  cloudPushUrl: DEFAULT_PUSHER_URL
}

// app state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface AppState {
  savedAccounts: ZulipCredentials[]  // all saved accounts
  activeAccount: ZulipCredentials | null  // currently connected account
  connectionState: ConnectionState
  lastEventTime: number | null
  error: string | null
  userId: number | null
  userEmail: string | null
  settings: AppSettings
}

// abstractions for platform-specific implementations
export interface StorageService {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
}

export interface NotificationOptions {
  silent?: boolean
}

export interface NotificationService {
  requestPermission(): Promise<boolean>
  isSupported(): boolean
  showNotification(title: string, body: string, tag?: string, options?: NotificationOptions): Promise<void>
  playSound?(): void // optional, for web-push sound-only mode
}
