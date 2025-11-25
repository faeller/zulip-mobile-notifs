// zulip api types

export type AuthMethod = 'password' | 'sso' | 'zuliprc' | 'manual'

export interface ZulipCredentials {
  serverUrl: string
  email: string
  apiKey: string
  authMethod?: AuthMethod  // how the credentials were obtained
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
  // notification settings
  soundEveryMessage: boolean // true = sound on every msg, false = only first in conversation
  groupByConversation: boolean // true = stack msgs per conversation, false = separate notifs
  vibrate: boolean // vibrate on notification
  openZulipApp: boolean // true = open zulip mobile app, false = open our app
  notificationSound: string | null // custom sound uri, null = default
  notificationSoundTitle: string | null // display name for custom sound
  // notification filters
  notifyOnMention: boolean // notify on @-mentions
  notifyOnPM: boolean // notify on private messages
  notifyOnOther: boolean // notify on other stream messages
  muteSelfMessages: boolean // don't notify on your own messages
  mutedStreams: string[] // stream names to exclude
  mutedTopics: string[] // topic patterns to exclude
  // quiet hours
  quietHoursEnabled: boolean
  quietHoursStart: string // HH:MM format
  quietHoursEnd: string // HH:MM format
}

export const DEFAULT_SETTINGS: AppSettings = {
  keepaliveSec: 90,
  soundEveryMessage: false,
  groupByConversation: true,
  vibrate: true,
  openZulipApp: true,
  notificationSound: null,
  notificationSoundTitle: null,
  // filters
  notifyOnMention: true,
  notifyOnPM: true,
  notifyOnOther: false,
  muteSelfMessages: true,
  mutedStreams: [],
  mutedTopics: [],
  // quiet hours
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00'
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

export interface NotificationService {
  requestPermission(): Promise<boolean>
  isSupported(): boolean
  showNotification(title: string, body: string, tag?: string): Promise<void>
}
