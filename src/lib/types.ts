// zulip api types

export interface ZulipCredentials {
  serverUrl: string
  email: string
  apiKey: string
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  keepaliveSec: 90 // 90s is reasonable - low overhead, quick-ish dead connection detection
}

// app state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface AppState {
  credentials: ZulipCredentials | null
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
