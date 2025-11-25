import type { NotificationService } from './types.ts'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

// detect if running in capacitor native app
const isNative = Capacitor.isNativePlatform()

// browser notification api implementation
class BrowserNotifications implements NotificationService {
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

    new Notification(title, {
      body,
      tag,
      icon: './icon.svg',
      badge: './icon.svg',
      requireInteraction: false
    })
  }
}

// native (capacitor) notification implementation
class NativeNotifications implements NotificationService {
  private notificationId = 1

  isSupported(): boolean {
    return true
  }

  async requestPermission(): Promise<boolean> {
    const result = await LocalNotifications.requestPermissions()
    return result.display === 'granted'
  }

  async showNotification(title: string, body: string, _tag?: string): Promise<void> {
    await LocalNotifications.schedule({
      notifications: [{
        id: this.notificationId++,
        title,
        body,
        smallIcon: 'ic_notification',
        largeIcon: 'ic_launcher',
        sound: 'default'
      }]
    })
  }
}

// auto-select implementation based on platform
export const notifications: NotificationService = isNative
  ? new NativeNotifications()
  : new BrowserNotifications()
