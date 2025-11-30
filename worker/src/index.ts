// zulip-web-pusher cloudflare worker
// polls zulip for registered users and sends web push notifications

import { encryptCredentials, decryptCredentials } from './crypto'
import { sendWebPush } from './web-push'
import {
  type FilterSettings,
  DEFAULT_FILTER_SETTINGS,
  shouldNotify,
  messageFromZulipFlags
} from '../../src/shared/filters'

interface Env {
  SUBSCRIPTIONS: KVNamespace
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
  ENCRYPTION_SECRET: string
}

interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  zulipServerUrl: string
  encryptedCredentials: string
  filters: FilterSettings
  queueId: string | null
  lastEventId: number
  failures: number
  createdAt: number
  updatedAt: number
}

interface ZulipMessage {
  id: number
  sender_id: number
  sender_full_name: string
  content: string
  subject: string
  type: 'stream' | 'private'
  display_recipient: string | { email: string }[]
  flags: string[]
}

interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
}

const VERSION = '0.2.0'
const MAX_FAILURES = 5

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors })
    }

    try {
      switch (url.pathname) {
        case '/status':
          return json({ status: 'ok', version: VERSION }, cors)

        case '/vapid-public-key':
          return json({ publicKey: env.VAPID_PUBLIC_KEY }, cors)

        case '/register':
          if (request.method !== 'POST') return json({ error: 'method not allowed' }, cors, 405)
          return handleRegister(request, env, cors)

        case '/update':
          if (request.method !== 'POST') return json({ error: 'method not allowed' }, cors, 405)
          return handleUpdate(request, env, cors)

        case '/unregister':
          if (request.method !== 'POST') return json({ error: 'method not allowed' }, cors, 405)
          return handleUnregister(request, env, cors)

        case '/test-push':
          if (request.method !== 'POST') return json({ error: 'method not allowed' }, cors, 405)
          return handleTestPush(request, env, cors)

        default:
          return json({ error: 'not found' }, cors, 404)
      }
    } catch (err) {
      console.error('request error:', err)
      return json({ error: 'internal error' }, cors, 500)
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollAllUsers(env))
  }
}

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  })
}

// register new subscription with credentials and filters
async function handleRegister(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
    zulipServerUrl: string
    zulipEmail: string
    zulipApiKey: string
    filters?: Partial<FilterSettings>
  }

  if (!body.subscription?.endpoint || !body.zulipServerUrl || !body.zulipEmail || !body.zulipApiKey) {
    return json({ error: 'missing required fields' }, cors, 400)
  }

  const encryptedCredentials = await encryptCredentials(
    env.ENCRYPTION_SECRET,
    body.subscription.endpoint,
    body.zulipEmail,
    body.zulipApiKey
  )

  // verify credentials
  try {
    const { email, apiKey } = await decryptCredentials(env.ENCRYPTION_SECRET, body.subscription.endpoint, encryptedCredentials)
    const res = await fetch(`${body.zulipServerUrl}/api/v1/users/me`, {
      headers: { Authorization: `Basic ${btoa(`${email}:${apiKey}`)}` }
    })
    if (!res.ok) return json({ error: 'invalid zulip credentials' }, cors, 401)
  } catch {
    return json({ error: 'failed to verify credentials' }, cors, 400)
  }

  const subscription: Subscription = {
    endpoint: body.subscription.endpoint,
    keys: body.subscription.keys,
    zulipServerUrl: body.zulipServerUrl,
    encryptedCredentials,
    filters: { ...DEFAULT_FILTER_SETTINGS, ...body.filters },
    queueId: null,
    lastEventId: -1,
    failures: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  await env.SUBSCRIPTIONS.put(body.subscription.endpoint, JSON.stringify(subscription))
  return json({ success: true, endpoint: body.subscription.endpoint }, cors)
}

// update filters for existing subscription
async function handleUpdate(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as {
    endpoint: string
    filters?: Partial<FilterSettings>
  }

  if (!body.endpoint) {
    return json({ error: 'missing endpoint' }, cors, 400)
  }

  const data = await env.SUBSCRIPTIONS.get(body.endpoint)
  if (!data) {
    return json({ error: 'subscription not found' }, cors, 404)
  }

  const sub: Subscription = JSON.parse(data)
  sub.filters = { ...sub.filters, ...body.filters }
  sub.updatedAt = Date.now()

  await env.SUBSCRIPTIONS.put(body.endpoint, JSON.stringify(sub))
  return json({ success: true }, cors)
}

async function handleUnregister(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as { endpoint: string }
  if (!body.endpoint) return json({ error: 'missing endpoint' }, cors, 400)

  await env.SUBSCRIPTIONS.delete(body.endpoint)
  return json({ success: true }, cors)
}

// send a test push notification
async function handleTestPush(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as { endpoint: string }
  if (!body.endpoint) return json({ error: 'missing endpoint' }, cors, 400)

  const data = await env.SUBSCRIPTIONS.get(body.endpoint)
  if (!data) return json({ error: 'subscription not found' }, cors, 404)

  const sub: Subscription = JSON.parse(data)

  const payload = JSON.stringify({
    title: 'Test Notification',
    body: `Cloud push is working! (${new Date().toLocaleTimeString()})`,
    tag: 'zulip-test'
  })

  try {
    console.log('[test-push] sending to:', sub.endpoint.slice(0, 60))
    console.log('[test-push] payload:', payload)

    const res = await sendWebPush(
      sub.endpoint, sub.keys.p256dh, sub.keys.auth, payload,
      env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT
    )

    console.log('[test-push] response status:', res.status)

    if (res.status === 410 || res.status === 404) {
      await env.SUBSCRIPTIONS.delete(sub.endpoint)
      return json({ error: 'subscription expired', status: res.status }, cors, 410)
    }

    if (!res.ok) {
      const text = await res.text()
      console.log('[test-push] error response:', text)
      return json({ error: 'push failed', status: res.status, details: text }, cors, 502)
    }

    return json({ success: true, status: res.status }, cors)
  } catch (err) {
    console.error('[test-push] exception:', err)
    return json({ error: (err as Error).message }, cors, 500)
  }
}

async function pollAllUsers(env: Env) {
  for (let round = 0; round < 4; round++) {
    const list = await env.SUBSCRIPTIONS.list()
    const batchSize = 40

    for (let i = 0; i < list.keys.length; i += batchSize) {
      const batch = list.keys.slice(i, i + batchSize)
      await Promise.all(batch.map(key => pollUser(key.name, env)))
    }

    if (round < 3) await new Promise(r => setTimeout(r, 15000))
  }
}

async function pollUser(endpoint: string, env: Env) {
  const start = Date.now()
  try {
    const data = await env.SUBSCRIPTIONS.get(endpoint)
    if (!data) return

    const sub: Subscription = JSON.parse(data)
    const { email, apiKey } = await decryptCredentials(env.ENCRYPTION_SECRET, endpoint, sub.encryptedCredentials)
    const auth = `Basic ${btoa(`${email}:${apiKey}`)}`

    // register queue if needed (get all messages, filter client-side)
    if (!sub.queueId) {
      const res = await fetch(`${sub.zulipServerUrl}/api/v1/register`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'event_types=["message"]'
      })

      if (!res.ok) {
        await incrementFailures(endpoint, sub, env)
        return
      }

      const reg = await res.json() as { queue_id: string; last_event_id: number }
      sub.queueId = reg.queue_id
      sub.lastEventId = reg.last_event_id
      await env.SUBSCRIPTIONS.put(endpoint, JSON.stringify(sub))
    }

    // poll events
    const res = await fetch(
      `${sub.zulipServerUrl}/api/v1/events?queue_id=${sub.queueId}&last_event_id=${sub.lastEventId}&dont_block=true`,
      { headers: { Authorization: auth } }
    )

    if (res.status === 400) {
      sub.queueId = null
      await env.SUBSCRIPTIONS.put(endpoint, JSON.stringify(sub))
      return
    }

    if (!res.ok) {
      await incrementFailures(endpoint, sub, env)
      return
    }

    const { events } = await res.json() as { events: ZulipEvent[] }

    // use default filters for old subscriptions that don't have them
    const filters = sub.filters || DEFAULT_FILTER_SETTINGS

    for (const event of events) {
      if (event.type === 'message' && event.message) {
        const msg = event.message
        const streamName = typeof msg.display_recipient === 'string' ? msg.display_recipient : undefined
        const filterableMsg = messageFromZulipFlags(msg.sender_id, msg.type, msg.flags, streamName, msg.subject)
        const result = shouldNotify(filters, filterableMsg)
        if (result.notify) {
          await sendPushNotification(sub, msg, env)
        }
      }
      sub.lastEventId = Math.max(sub.lastEventId, event.id)
    }

    sub.failures = 0
    await env.SUBSCRIPTIONS.put(endpoint, JSON.stringify(sub))
    console.log(`[poll] ${endpoint.slice(-20)} ${Date.now() - start}ms`)
  } catch (err) {
    console.error(`poll error for ${endpoint}:`, err)
  }
}

async function incrementFailures(endpoint: string, sub: Subscription, env: Env) {
  sub.failures++
  if (sub.failures >= MAX_FAILURES) {
    console.log(`removing ${endpoint} after ${MAX_FAILURES} failures`)
    await env.SUBSCRIPTIONS.delete(endpoint)
  } else {
    await env.SUBSCRIPTIONS.put(endpoint, JSON.stringify(sub))
  }
}

async function sendPushNotification(sub: Subscription, msg: ZulipMessage, env: Env) {
  const isDM = msg.type === 'private'
  const title = isDM
    ? `DM from ${msg.sender_full_name}`
    : `${msg.sender_full_name} in #${msg.display_recipient}`

  const body = stripHtml(msg.content).slice(0, 200)

  const payload = JSON.stringify({
    title,
    body,
    tag: `zulip-${msg.id}`,
    messageId: msg.id
  })

  try {
    const res = await sendWebPush(
      sub.endpoint, sub.keys.p256dh, sub.keys.auth, payload,
      env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT
    )

    if (res.status === 410 || res.status === 404) {
      console.log(`subscription expired: ${sub.endpoint}`)
      await env.SUBSCRIPTIONS.delete(sub.endpoint)
      return
    }

    if (!res.ok) {
      console.error(`push failed: ${res.status}`)
      await incrementFailures(sub.endpoint, sub, env)
    }
  } catch (err) {
    console.error('push error:', err)
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
