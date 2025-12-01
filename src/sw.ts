/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// auto-update: activate new SW immediately
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// precache assets
precacheAndRoute(self.__WB_MANIFEST)

// handle push notifications from cloud pusher
self.addEventListener('push', (event) => {
  console.log('[sw] push event received!')

  // check for updates on each push
  self.registration.update().catch(() => {})

  // must always show a notification (userVisibleOnly requirement)
  // otherwise chrome shows "site updated in background" message
  const showNotification = async () => {
    try {
      const data = event.data?.json() ?? {}
      const options = {
        body: data.body || '',
        icon: '/pwa-192.png',
        badge: '/pwa-192.png',
        tag: data.tag || 'zulip-notification',
        renotify: true,
        data: { url: data.url || '/', messageId: data.messageId }
      } as NotificationOptions
      await self.registration.showNotification(data.title || 'Zulip', options)
    } catch (err) {
      // fallback notification on error
      console.error('[sw] push error:', err)
      await self.registration.showNotification('Zulip', { body: 'New message' })
    }
  }

  event.waitUntil(showNotification())
})

// handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const zulipUrl = event.notification.data?.url
  const appUrl = self.location.origin

  event.waitUntil(
    // check openZulipApp setting from localStorage
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      // try to get setting from an open client
      let openZulipApp = true // default
      for (const client of clients) {
        if (client.url.includes(appUrl)) {
          try {
            // ask client for the setting
            const response = await new Promise<boolean>((resolve) => {
              const channel = new MessageChannel()
              channel.port1.onmessage = (e) => resolve(e.data)
              client.postMessage({ type: 'getOpenZulipApp' }, [channel.port2])
              setTimeout(() => resolve(true), 100) // timeout fallback
            })
            openZulipApp = response
            break
          } catch { /* use default */ }
        }
      }

      const targetUrl = openZulipApp && zulipUrl ? zulipUrl : appUrl

      // focus existing window if targeting our app
      if (!openZulipApp || !zulipUrl) {
        for (const client of clients) {
          if (client.url.includes(appUrl) && 'focus' in client) {
            return client.focus()
          }
        }
      }

      return self.clients.openWindow(targetUrl)
    })
  )
})

// handle subscription change (browser refreshes subscription)
self.addEventListener('pushsubscriptionchange', () => {
  // re-subscribe and update server
  // for now just log - PWA will re-register on next open
  console.log('[sw] push subscription changed')
})
