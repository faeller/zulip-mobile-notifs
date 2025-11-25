import { Capacitor, registerPlugin } from '@capacitor/core'

interface ForegroundServicePlugin {
  start(): Promise<void>
  stop(): Promise<void>
}

const ForegroundService = registerPlugin<ForegroundServicePlugin>('ForegroundService')

const isNative = Capacitor.isNativePlatform()

// start foreground service (android only)
export async function startForegroundService(): Promise<void> {
  if (!isNative) {
    console.log('[service] not on native, skipping foreground service')
    return
  }

  console.log('[service] starting foreground service')
  await ForegroundService.start()
}

// stop foreground service
export async function stopForegroundService(): Promise<void> {
  if (!isNative) return

  console.log('[service] stopping foreground service')
  await ForegroundService.stop()
}
