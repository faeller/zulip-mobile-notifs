import type { StorageService } from './types.ts'

// browser localstorage implementation
// can be swapped for capacitor preferences on mobile
export class BrowserStorage implements StorageService {
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

// singleton for convenience
export const storage = new BrowserStorage()
