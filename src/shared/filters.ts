// filters.ts - shared notification filtering logic
// used by: web client, android (via rhino), cloudflare worker

export interface FilterSettings {
  notifyOnMention: boolean
  notifyOnDM: boolean
  notifyOnOther: boolean
  muteSelfMessages: boolean
  mutedStreams: string[]
  mutedTopics: string[]
  quietHoursEnabled: boolean
  quietHoursStart: string // HH:MM
  quietHoursEnd: string
  quietDaysEnabled: boolean
  quietDays: number[] // 0=sunday, 6=saturday
}

export interface FilterableMessage {
  senderId: number
  type: 'private' | 'stream'
  stream?: string
  subject?: string
  mentioned: boolean
  wildcardMentioned: boolean
}

export interface FilterResult {
  notify: boolean
  reason: string
}

export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  notifyOnMention: true,
  notifyOnDM: true,
  notifyOnOther: false,
  muteSelfMessages: true,
  mutedStreams: [],
  mutedTopics: [],
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  quietDaysEnabled: false,
  quietDays: []
}

export function isQuietHours(settings: FilterSettings): boolean {
  if (!settings.quietHoursEnabled) return false

  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const [startH, startM] = settings.quietHoursStart.split(':').map(Number)
  const [endH, endM] = settings.quietHoursEnd.split(':').map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes > endMinutes) {
    // overnight: 22:00 - 07:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes
  }
  // same day: 09:00 - 17:00
  return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

export function isQuietDay(settings: FilterSettings): boolean {
  if (!settings.quietDaysEnabled) return false
  if (!settings.quietDays?.length) return false
  return settings.quietDays.includes(new Date().getDay())
}

export function isChannelMuted(settings: FilterSettings, streamName?: string): boolean {
  if (!streamName || !settings.mutedStreams?.length) return false
  const streamLower = streamName.toLowerCase()
  return settings.mutedStreams.some(m => m.toLowerCase() === streamLower)
}

export function isTopicMuted(settings: FilterSettings, topic?: string): boolean {
  if (!topic || !settings.mutedTopics?.length) return false
  for (const pattern of settings.mutedTopics) {
    try {
      if (new RegExp(pattern, 'i').test(topic)) return true
    } catch {
      if (topic.toLowerCase().includes(pattern.toLowerCase())) return true
    }
  }
  return false
}

export function shouldNotify(
  settings: FilterSettings,
  msg: FilterableMessage,
  userId?: number
): FilterResult {
  // check self-message
  if (settings.muteSelfMessages && userId !== undefined && msg.senderId === userId) {
    return { notify: false, reason: 'self_message' }
  }

  // check quiet hours/days
  if (isQuietHours(settings)) {
    return { notify: false, reason: 'quiet_hours' }
  }
  if (isQuietDay(settings)) {
    return { notify: false, reason: 'quiet_day' }
  }

  const isDM = msg.type === 'private'
  const isMention = msg.mentioned || msg.wildcardMentioned

  // DM handling
  if (isDM) {
    return settings.notifyOnDM
      ? { notify: true, reason: 'dm' }
      : { notify: false, reason: 'dm_disabled' }
  }

  // stream message handling
  if (isMention && !settings.notifyOnMention) {
    return { notify: false, reason: 'mention_disabled' }
  }
  if (!isMention && !settings.notifyOnOther) {
    return { notify: false, reason: 'other_disabled' }
  }

  // check muted channels/topics
  if (isChannelMuted(settings, msg.stream)) {
    return { notify: false, reason: 'muted_channel' }
  }
  if (isTopicMuted(settings, msg.subject)) {
    return { notify: false, reason: 'muted_topic' }
  }

  return { notify: true, reason: isMention ? 'mention' : 'other' }
}

// helper to convert Zulip API message flags to FilterableMessage fields
export function messageFromZulipFlags(
  senderId: number,
  type: 'private' | 'stream',
  flags: string[],
  stream?: string,
  subject?: string
): FilterableMessage {
  return {
    senderId,
    type,
    stream,
    subject,
    mentioned: flags?.includes('mentioned') ?? false,
    wildcardMentioned: flags?.includes('wildcard_mentioned') ?? false
  }
}
