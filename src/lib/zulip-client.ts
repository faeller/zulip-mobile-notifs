import type { ZulipCredentials, RegisterResponse, AnyZulipEvent, ZulipUser } from './types.ts'

// zulip api client using event queue for efficient long-polling
export class ZulipClient {
  private credentials: ZulipCredentials
  private queueId: string | null = null
  private lastEventId: number = -1
  private abortController: AbortController | null = null

  constructor(credentials: ZulipCredentials) {
    this.credentials = credentials
  }

  // base64 encode for basic auth
  private getAuthHeader(): string {
    const encoded = btoa(`${this.credentials.email}:${this.credentials.apiKey}`)
    return `Basic ${encoded}`
  }

  // normalize server url (remove trailing slash)
  private getBaseUrl(): string {
    return this.credentials.serverUrl.replace(/\/+$/, '')
  }

  // generic api request handler
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    params?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<T> {
    const url = new URL(`${this.getBaseUrl()}/api/v1${endpoint}`)

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': this.getAuthHeader(),
      },
      signal
    }

    if (method === 'GET' && params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
    } else if (method === 'POST' && params) {
      options.headers = { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
      options.body = new URLSearchParams(params).toString()
    }

    // don't log polling requests (too noisy)
    const isPolling = endpoint === '/events' && method === 'GET'
    if (!isPolling) {
      console.log(`[zulip] ${method} ${endpoint}`)
    }

    const res = await fetch(url.toString(), options)

    if (!res.ok) {
      const text = await res.text()
      console.error(`[zulip] ${method} ${endpoint} failed:`, res.status, text)
      throw new Error(`Zulip API error ${res.status}: ${text}`)
    }

    return res.json()
  }

  // test credentials by fetching own user info
  async testConnection(): Promise<ZulipUser> {
    const res = await this.request<{ result: string; user_id: number; email: string; full_name: string }>('/users/me')
    if (res.result !== 'success') {
      throw new Error('Failed to authenticate with Zulip')
    }
    return { user_id: res.user_id, email: res.email, full_name: res.full_name }
  }

  // register event queue for receiving real-time updates
  async registerQueue(): Promise<RegisterResponse> {
    const res = await this.request<RegisterResponse & { result: string }>('/register', 'POST', {
      event_types: JSON.stringify(['message']),
      // no narrow = get all messages (we filter client-side)
      narrow: JSON.stringify([]),
      // include message content in events
      apply_markdown: 'false',
      client_gravatar: 'false'
    })

    this.queueId = res.queue_id
    this.lastEventId = res.last_event_id
    console.log(`[zulip] queue registered: ${res.queue_id}, last_event_id: ${res.last_event_id}`)

    return res
  }

  // long-poll for events - blocks until events arrive or timeout
  async getEvents(timeoutMs: number = 30000): Promise<AnyZulipEvent[]> {
    if (!this.queueId) {
      throw new Error('No queue registered, call registerQueue first')
    }

    // create abort controller for this request
    this.abortController = new AbortController()

    // add timeout via abort
    const timeoutId = setTimeout(() => this.abortController?.abort(), timeoutMs + 5000)

    try {
      const res = await this.request<{ events: AnyZulipEvent[]; result: string }>(
        '/events',
        'GET',
        {
          queue_id: this.queueId,
          last_event_id: this.lastEventId.toString(),
          // server-side timeout in seconds
          'blocking_timeout': Math.floor(timeoutMs / 1000).toString()
        },
        this.abortController.signal
      )

      clearTimeout(timeoutId)

      // update last event id
      if (res.events.length > 0) {
        this.lastEventId = res.events[res.events.length - 1].id
      }

      return res.events
    } catch (err) {
      clearTimeout(timeoutId)

      // check if aborted intentionally
      if (err instanceof Error && err.name === 'AbortError') {
        return []
      }
      throw err
    }
  }

  // abort current poll request (used when settings change)
  abortCurrentPoll(): void {
    this.abortController?.abort()
  }

  // cleanup - delete queue and abort pending requests
  async disconnect(): Promise<void> {
    this.abortController?.abort()

    if (this.queueId) {
      try {
        await this.request('/events', 'DELETE', { queue_id: this.queueId })
      } catch {
        // ignore errors on cleanup
      }
      this.queueId = null
    }

    this.lastEventId = -1
  }

  // check if connected (has active queue)
  isConnected(): boolean {
    return this.queueId !== null
  }

  // fetch unread private messages and mentions (for catch-up after reconnect)
  async getUnreadMessages(): Promise<{ id: number; type: string; sender_full_name: string; content: string; subject?: string; display_recipient: string | ZulipUser[] }[]> {
    const response = await this.request<{
      result: string
      messages: { id: number; type: string; sender_full_name: string; content: string; subject?: string; display_recipient: string | ZulipUser[]; flags: string[] }[]
    }>('/messages', 'GET', {
      anchor: 'newest',
      num_before: '50',
      num_after: '0',
      narrow: JSON.stringify([{ operator: 'is', operand: 'unread' }])
    })

    // filter to only PMs and mentions
    return response.messages.filter(m =>
      m.type === 'private' ||
      m.flags?.includes('mentioned') ||
      m.flags?.includes('wildcard_mentioned')
    )
  }

  // fetch subscribed streams/channels
  async getSubscriptions(): Promise<{ name: string; stream_id: number; is_muted: boolean }[]> {
    const response = await this.request<{
      result: string
      subscriptions: { name: string; stream_id: number; is_muted: boolean }[]
    }>('/users/me/subscriptions')

    return response.subscriptions.map(s => ({
      name: s.name,
      stream_id: s.stream_id,
      is_muted: s.is_muted
    }))
  }

  // fetch topics for a specific stream
  async getStreamTopics(streamId: number): Promise<{ name: string; max_id: number }[]> {
    const response = await this.request<{
      result: string
      topics: { name: string; max_id: number }[]
    }>(`/users/me/${streamId}/topics`)

    return response.topics || []
  }

  // fetch all topics from all subscribed channels
  async getAllTopics(): Promise<{ stream_name: string; topic: string }[]> {
    const subs = await this.getSubscriptions()
    const allTopics: { stream_name: string; topic: string }[] = []

    // fetch topics from each channel (limit to first 10 to avoid too many requests)
    const channelsToFetch = subs.slice(0, 10)

    await Promise.all(channelsToFetch.map(async (sub) => {
      try {
        const topics = await this.getStreamTopics(sub.stream_id)
        for (const t of topics.slice(0, 20)) { // limit topics per channel
          allTopics.push({ stream_name: sub.name, topic: t.name })
        }
      } catch {
        // ignore errors for individual streams
      }
    }))

    return allTopics
  }
}
