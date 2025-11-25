import type { StorageService } from './types.ts'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

const isNative = Capacitor.isNativePlatform()

// browser localstorage implementation
class BrowserStorage implements StorageService {
  private prefix: string

  constructor(prefix: string = 'zulip-notifs') {
    this.prefix = prefix
  }

  private key(k: string): string {
    return `${this.prefix}:${k}`
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(this.key(key))
      if (!raw) return null
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    localStorage.setItem(this.key(key), JSON.stringify(value))
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(this.key(key))
  }
}

// native (capacitor) preferences implementation
class NativeStorage implements StorageService {
  async get<T>(key: string): Promise<T | null> {
    try {
      const { value } = await Preferences.get({ key })
      if (!value) return null
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await Preferences.set({ key, value: JSON.stringify(value) })
  }

  async remove(key: string): Promise<void> {
    await Preferences.remove({ key })
  }
}

// auto-select based on platform
export const storage: StorageService = isNative
  ? new NativeStorage()
  : new BrowserStorage()
