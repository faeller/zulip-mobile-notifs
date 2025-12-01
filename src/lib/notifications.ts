import type { NotificationService, NotificationOptions } from './types.ts'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

// detect if running in capacitor native app
const isNative = Capacitor.isNativePlatform()

// browser notification api implementation
class BrowserNotifications implements NotificationService {
  private audioElement: HTMLAudioElement | null = null
  private customSoundUrl: string | null = null

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

  // set custom sound from file (web only)
  setCustomSound(file: File | null): void {
    if (this.customSoundUrl) {
      URL.revokeObjectURL(this.customSoundUrl)
      this.customSoundUrl = null
    }
    if (file) {
      this.customSoundUrl = URL.createObjectURL(file)
      // preload audio
      this.audioElement = new Audio(this.customSoundUrl)
      this.audioElement.load()
    } else {
      this.audioElement = null
    }
  }

  private playCustomSound(): void {
    if (this.audioElement) {
      // clone and play to allow overlapping
      const sound = this.audioElement.cloneNode() as HTMLAudioElement
      sound.play().catch(() => {})
    }
  }

  // play sound only (for web-push mode when tab is open)
  playSound(): void {
    this.playCustomSound()
  }

  async showNotification(title: string, body: string, tag?: string, options?: NotificationOptions): Promise<void> {
    if (!this.isSupported()) return
    if (Notification.permission !== 'granted') return

    const shouldPlaySound = !options?.silent
    const hasCustomSound = !!this.audioElement

    new Notification(title, {
      body,
      tag,
      icon: './icon.svg',
      badge: './icon.svg',
      requireInteraction: false,
      // silence browser if: no sound wanted OR we'll play custom sound instead
      silent: !shouldPlaySound || hasCustomSound
    })

    // only play custom sound if sound enabled and custom sound exists
    if (shouldPlaySound && hasCustomSound) {
      this.playCustomSound()
    }
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

  async showNotification(title: string, body: string, _tag?: string, options?: NotificationOptions): Promise<void> {
    await LocalNotifications.schedule({
      notifications: [{
        id: this.notificationId++,
        title,
        body,
        smallIcon: 'ic_notification',
        largeIcon: 'ic_launcher',
        sound: options?.silent ? undefined : 'default'
      }]
    })
  }
}

// auto-select implementation based on platform
export const notifications: NotificationService = isNative
  ? new NativeNotifications()
  : new BrowserNotifications()
