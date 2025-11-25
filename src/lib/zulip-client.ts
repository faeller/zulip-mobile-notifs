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
}
