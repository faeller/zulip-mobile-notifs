import { Capacitor, registerPlugin } from '@capacitor/core'

interface SoundPickerResult {
  uri?: string
  title?: string
}

interface ForegroundServicePlugin {
  start(): Promise<void>
  stop(): Promise<void>
  pickNotificationSound(options?: { currentUri?: string }): Promise<SoundPickerResult>
  pickSoundFile(): Promise<SoundPickerResult>
  downloadAndSetSound(options: { url: string, fileName?: string }): Promise<SoundPickerResult>
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

// pick notification sound using system picker (android only)
export async function pickNotificationSound(currentUri?: string): Promise<SoundPickerResult | null> {
  if (!isNative) return null

  const result = await ForegroundService.pickNotificationSound({ currentUri })
  return result.uri !== undefined ? result : null
}

// pick sound file directly (android only)
export async function pickSoundFile(): Promise<SoundPickerResult | null> {
  if (!isNative) return null

  const result = await ForegroundService.pickSoundFile()
  return result.uri !== undefined ? result : null
}

// download sound from url and return uri (android only)
export async function downloadAndSetSound(url: string, fileName?: string): Promise<SoundPickerResult | null> {
  if (!isNative) return null

  const result = await ForegroundService.downloadAndSetSound({ url, fileName })
  return result.uri !== undefined ? result : null
}
