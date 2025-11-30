// web-push.ts
// web push subscription management for cloud push notifications

import { DEFAULT_PUSHER_URL } from './types'
import type { FilterSettings } from '../shared/filters'

export interface PushSubscriptionData {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

export interface PusherStatus {
  online: boolean
  version?: string
  error?: string
}

// convert base64url to Uint8Array for applicationServerKey
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

// fetch VAPID public key from pusher server
// normalize URL to ensure https://
function normalizeUrl(url: string): string {
  url = url.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }
  return url.replace(/\/$/, '') // remove trailing slash
}

async function getVapidPublicKey(pusherUrl: string): Promise<string> {
  const url = normalizeUrl(pusherUrl)
  const res = await fetch(`${url}/vapid-public-key`)
  if (!res.ok) throw new Error('failed to fetch VAPID public key')
  const data = await res.json()
  return data.publicKey
}

// check if push is supported
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

// get existing subscription if any
export async function getExistingSubscription(): Promise<PushSubscriptionData | null> {
  if (!isPushSupported()) return null

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return null

    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null

    return {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
    }
  } catch {
    return null
  }
}

// subscribe to web push
export async function subscribeToPush(pusherUrl: string = DEFAULT_PUSHER_URL): Promise<PushSubscriptionData> {
  if (!isPushSupported()) {
    throw new Error('push notifications not supported')
  }

  const registration = await navigator.serviceWorker.ready
  const vapidPublicKey = await getVapidPublicKey(pusherUrl)

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('invalid subscription')
  }

  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
  }
}

// unsubscribe from push
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    await subscription.unsubscribe()
  }
}

// register with pusher server (credentials sent over HTTPS, encrypted server-side)
export async function registerWithPusher(
  pusherUrl: string,
  subscription: PushSubscriptionData,
  zulipServerUrl: string,
  zulipEmail: string,
  zulipApiKey: string,
  filters?: Partial<FilterSettings>
): Promise<{ success: boolean; endpoint?: string; error?: string }> {
  const url = normalizeUrl(pusherUrl)
  try {
    const res = await fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription,
        zulipServerUrl,
        zulipEmail,
        zulipApiKey,
        filters
      })
    })

    const data = await res.json()
    if (!res.ok) {
      return { success: false, error: data.error || 'registration failed' }
    }

    return { success: true, endpoint: data.endpoint }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// update filter settings on pusher server
export async function updatePusherFilters(
  pusherUrl: string,
  endpoint: string,
  filters: Partial<FilterSettings>
): Promise<{ success: boolean; error?: string }> {
  const url = normalizeUrl(pusherUrl)
  try {
    const res = await fetch(`${url}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, filters })
    })

    const data = await res.json()
    if (!res.ok) {
      return { success: false, error: data.error || 'update failed' }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// send test push notification
export async function testPush(
  pusherUrl: string,
  endpoint: string
): Promise<{ success: boolean; error?: string }> {
  const url = normalizeUrl(pusherUrl)
  try {
    const res = await fetch(`${url}/test-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint })
    })

    const data = await res.json()
    if (!res.ok) {
      return { success: false, error: data.error || `push failed (${res.status})` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// unregister from pusher server
export async function unregisterFromPusher(
  pusherUrl: string,
  endpoint: string
): Promise<boolean> {
  const url = normalizeUrl(pusherUrl)
  try {
    const res = await fetch(`${url}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint })
    })
    return res.ok
  } catch {
    return false
  }
}

// check pusher server status
export async function checkPusherStatus(pusherUrl: string = DEFAULT_PUSHER_URL): Promise<PusherStatus> {
  const url = normalizeUrl(pusherUrl)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch(`${url}/status`, {
      method: 'GET',
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!res.ok) return { online: false, error: `HTTP ${res.status}` }

    const data = await res.json()
    return { online: true, version: data.version }
  } catch (err) {
    return { online: false, error: (err as Error).message }
  }
}
