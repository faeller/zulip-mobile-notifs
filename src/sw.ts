/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// precache assets
precacheAndRoute(self.__WB_MANIFEST)

// handle push notifications from cloud pusher
self.addEventListener('push', (event) => {
  console.log('[sw] push event received!')

  if (!event.data) {
    console.log('[sw] no data in push event')
    return
  }

  try {
    const data = event.data.json()
    console.log('[sw] push data:', data)

    const options = {
      body: data.body || '',
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      tag: data.tag || 'zulip-notification',
      renotify: true,
      data: {
        url: data.url || '/',
        messageId: data.messageId
      }
    } as NotificationOptions

    event.waitUntil(
      self.registration.showNotification(data.title || 'Zulip', options)
        .then(() => console.log('[sw] notification shown'))
        .catch(err => console.error('[sw] notification error:', err))
    )
  } catch (err) {
    console.error('[sw] push parse error:', err)
  }
})

// handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      // otherwise open new window
      return self.clients.openWindow(url)
    })
  )
})

// handle subscription change (browser refreshes subscription)
self.addEventListener('pushsubscriptionchange', () => {
  // re-subscribe and update server
  // for now just log - PWA will re-register on next open
  console.log('[sw] push subscription changed')
})
