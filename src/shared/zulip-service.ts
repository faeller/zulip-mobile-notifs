// zulip-service.ts
// shared service logic for both web and native (via rhino)
// this module handles all business logic, java/web just provides platform APIs

// ============================================================================
// TYPES
// ============================================================================

export interface NotificationSettings {
  playSounds: boolean
  groupByConversation: boolean
  vibrate: boolean
  openZulipApp: boolean
  showTimestamps: boolean
  notificationSound: string | null
  notifyOnMention: boolean
  notifyOnDM: boolean
  notifyOnOther: boolean
  muteSelfMessages: boolean
  mutedStreams: string[]
  mutedTopics: string[]
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  quietDaysEnabled: boolean
  quietDays: number[]
}

export interface ZulipMessage {
  id: number
  senderId: number
  senderName: string
  senderEmail: string
  type: 'private' | 'stream'
  stream?: string
  subject?: string
  content: string
  timestamp: number
  mentioned: boolean
  wildcardMentioned: boolean
}

export interface FilterResult {
  notify: boolean
  reason: string
}

export interface NotificationData {
  id: number
  title: string
  body: string
  conversationKey: string
  conversationTitle: string | null
  senderName: string
  timestamp: number
  silent: boolean
}

export interface MessageEvent {
  type: 'message'
  message: ZulipMessage
}

// ============================================================================
// NOTIFICATION FILTER
// ============================================================================

const NotificationFilter = {
  isQuietHours(settings: NotificationSettings): boolean {
    if (!settings.quietHoursEnabled) return false

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    const [startH, startM] = settings.quietHoursStart.split(':').map(Number)
    const [endH, endM] = settings.quietHoursEnd.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  },

  isQuietDay(settings: NotificationSettings): boolean {
    if (!settings.quietDaysEnabled) return false
    if (!settings.quietDays || settings.quietDays.length === 0) return false
    return settings.quietDays.includes(new Date().getDay())
  },

  isChannelMuted(settings: NotificationSettings, streamName?: string): boolean {
    if (!streamName || !settings.mutedStreams?.length) return false
    const streamLower = streamName.toLowerCase()
    return settings.mutedStreams.some(m => m.toLowerCase() === streamLower)
  },

  isTopicMuted(settings: NotificationSettings, topic?: string): boolean {
    if (!topic || !settings.mutedTopics?.length) return false
    for (const pattern of settings.mutedTopics) {
      try {
        if (new RegExp(pattern, 'i').test(topic)) return true
      } catch {
        if (topic.toLowerCase().includes(pattern.toLowerCase())) return true
      }
    }
    return false
  },

  shouldNotify(settings: NotificationSettings, msg: ZulipMessage, userId: number): FilterResult {
    if (settings.muteSelfMessages && msg.senderId === userId) {
      return { notify: false, reason: 'self_message' }
    }
    if (this.isQuietHours(settings)) {
      return { notify: false, reason: 'quiet_hours' }
    }
    if (this.isQuietDay(settings)) {
      return { notify: false, reason: 'quiet_day' }
    }

    const isDM = msg.type === 'private'
    const isMention = msg.mentioned || msg.wildcardMentioned

    if (isDM) {
      return settings.notifyOnDM
        ? { notify: true, reason: 'dm' }
        : { notify: false, reason: 'dm_disabled' }
    }

    if (isMention && !settings.notifyOnMention) {
      return { notify: false, reason: 'mention_disabled' }
    }
    if (!isMention && !settings.notifyOnOther) {
      return { notify: false, reason: 'other_disabled' }
    }
    if (this.isChannelMuted(settings, msg.stream)) {
      return { notify: false, reason: 'muted_channel' }
    }
    if (this.isTopicMuted(settings, msg.subject)) {
      return { notify: false, reason: 'muted_topic' }
    }

    return { notify: true, reason: isMention ? 'mention' : 'other' }
  }
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

const MessageFormatter = {
  stripHtml(html: string): string {
    if (!html) return ''
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  },

  formatMarkdown(text: string): string {
    // [link text](url) -> link text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // @_**name** -> @**name**
    text = text.replace(/@_\*\*/g, '@**')
    // remove |user_id from mentions
    text = text.replace(/\|\d+\*\*/g, '**')
    // ```quote ... ``` -> "content"
    text = text.replace(/```quote\s*\n?(.+?)\s*```\s*/gs, '"$1"\n')
    // ``` code ``` -> content
    text = text.replace(/```\w*\s*\n?(.+?)\n?```/gs, '$1')
    // ``quote`` -> "content"
    text = text.replace(/``([^`]+)``/g, '"$1"')
    // > quote -> remove prefix
    text = text.replace(/^>+\s*/gm, '')
    // normalize newlines
    text = text.replace(/\n+/g, '\n')
    // **bold** -> bold (for plain text)
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
    // *italic* -> italic
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    // `code` -> code
    text = text.replace(/`([^`]+)`/g, '$1')
    return text.trim()
  },

  getConversationKey(msg: ZulipMessage): string {
    if (msg.type === 'private') {
      return `pm:${msg.senderId}`
    }
    return `stream:${msg.stream}::${msg.subject}`
  },

  getConversationTitle(msg: ZulipMessage): string | null {
    if (msg.type === 'private') return null
    return `#${msg.stream} > ${msg.subject}`
  },

  formatNotification(msg: ZulipMessage, settings: NotificationSettings): NotificationData {
    let body = this.stripHtml(msg.content)
    body = this.formatMarkdown(body)
    if (body.length > 300) {
      body = body.substring(0, 300) + '...'
    }

    let title: string
    if (msg.type === 'private') {
      title = `DM from ${msg.senderName}`
    } else {
      title = `${msg.senderName} in #${msg.stream} > ${msg.subject}`
    }

    return {
      id: msg.id,
      title,
      body,
      conversationKey: this.getConversationKey(msg),
      conversationTitle: this.getConversationTitle(msg),
      senderName: msg.senderName,
      timestamp: msg.timestamp || Date.now(),
      silent: !settings.playSounds
    }
  },

  formatTime(timestamp: number): string {
    const d = new Date(timestamp)
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }
}

// ============================================================================
// SERVICE STATE (for future: full polling logic in JS)
// ============================================================================

interface ServiceState {
  userId: number | null
  settings: NotificationSettings | null
  lastEventId: number
  conversationCounts: Map<string, number>
}

const state: ServiceState = {
  userId: null,
  settings: null,
  lastEventId: -1,
  conversationCounts: new Map()
}

const ServiceLogic = {
  init(userId: number, settings: NotificationSettings) {
    state.userId = userId
    state.settings = settings
  },

  updateSettings(settings: NotificationSettings) {
    state.settings = settings
  },

  // process a message event, returns notification data if should notify
  processMessage(msg: ZulipMessage): NotificationData | null {
    if (!state.settings || state.userId === null) {
      return null
    }

    const result = NotificationFilter.shouldNotify(state.settings, msg, state.userId)
    if (!result.notify) {
      return null
    }

    return MessageFormatter.formatNotification(msg, state.settings)
  },

  // track conversation message counts for bundling
  incrementConversation(key: string): number {
    const count = (state.conversationCounts.get(key) || 0) + 1
    state.conversationCounts.set(key, count)
    return count
  },

  resetConversation(key: string) {
    state.conversationCounts.delete(key)
  },

  clearAllConversations() {
    state.conversationCounts.clear()
  }
}

// ============================================================================
// ENTRY POINTS FOR JAVA/RHINO
// ============================================================================

// initialize service with user id and settings
function initService(userId: number, settingsJson: string): string {
  try {
    const settings = JSON.parse(settingsJson) as NotificationSettings
    ServiceLogic.init(userId, settings)
    return JSON.stringify({ success: true })
  } catch (e) {
    return JSON.stringify({ success: false, error: (e as Error).message })
  }
}

// update settings
function updateSettings(settingsJson: string): string {
  try {
    const settings = JSON.parse(settingsJson) as NotificationSettings
    ServiceLogic.updateSettings(settings)
    return JSON.stringify({ success: true })
  } catch (e) {
    return JSON.stringify({ success: false, error: (e as Error).message })
  }
}

// process a message, returns notification data or null
function processMessage(msgJson: string): string {
  try {
    const msg = JSON.parse(msgJson) as ZulipMessage
    const result = ServiceLogic.processMessage(msg)
    return JSON.stringify(result)
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// simple filter check (stateless, for backwards compat)
function filterMessage(settingsJson: string, msgJson: string, userId: number): string {
  try {
    const settings = JSON.parse(settingsJson) as NotificationSettings
    const msg = JSON.parse(msgJson) as ZulipMessage
    const result = NotificationFilter.shouldNotify(settings, msg, userId)
    return JSON.stringify(result)
  } catch (e) {
    return JSON.stringify({ notify: true, reason: 'error', error: (e as Error).message })
  }
}

// format a message for notification
function formatMessage(msgJson: string, settingsJson: string): string {
  try {
    const msg = JSON.parse(msgJson) as ZulipMessage
    const settings = JSON.parse(settingsJson) as NotificationSettings
    const result = MessageFormatter.formatNotification(msg, settings)
    return JSON.stringify(result)
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// format timestamp
function formatTime(timestamp: number): string {
  return MessageFormatter.formatTime(timestamp)
}

// export for web usage
export {
  NotificationFilter,
  MessageFormatter,
  ServiceLogic,
  initService,
  updateSettings,
  processMessage,
  filterMessage,
  formatMessage,
  formatTime
}
