import type { NotificationService } from './types.ts'

// browser notification api implementation
// can be swapped for capacitor local notifications on mobile
export class BrowserNotifications implements NotificationService {
  isSupported(): boolean {
    return 'Notification' in window
  }

  async requestPermission(): Promise<boolean> {
    if (!this.isSupported()) return false

    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false

    const result = await Notification.requestPermission()
    return result === 'granted'
  }

  async showNotification(title: string, body: string, tag?: string): Promise<void> {
    if (!this.isSupported()) return
    if (Notification.permission !== 'granted') return

    // use tag to dedupe notifications from same sender
    new Notification(title, {
      body,
      tag,
      icon: './icon.svg',
      badge: './icon.svg',
      requireInteraction: false
    })
  }
}

// singleton
export const notifications = new BrowserNotifications()
