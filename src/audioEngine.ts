/**
 * audioEngine.ts — Frontend API client
 * =====================================
 * Sends the audio file + settings to the local Node.js server (port 3001)
 * which processes it using system ffmpeg.
 * No browser WASM, no SharedArrayBuffer, no security header issues.
 */

export type AudioSettings = {
  speed: number
  pitch: number
  volume: number
  highFrequencyReduction: number
  bypassMode: boolean
  phaserAmount: number
  vibratoAmount: number
  launderingLevel: 'none' | 'medium' | 'severe' | 'extreme'
  silentDropouts: boolean
  dropoutInterval: number
  dropoutDuration: number
}

type ProgressCallback = (message: string) => void

const SERVER = ''

export async function processAudio(
  file: File,
  settings: AudioSettings,
  onProgress: ProgressCallback
): Promise<Blob> {

  // Check server is reachable first
  onProgress('Connecting to local processing server…')
  try {
    const health = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) })
    if (!health.ok) throw new Error('Server returned an error.')
  } catch {
    throw new Error(
      'Cannot reach the local server on port 3001. ' +
      'Open a terminal in the project folder and run: node server.js'
    )
  }

  onProgress('Uploading audio to local server…')
  const form = new FormData()
  form.append('file', file)
  form.append('speed',  String(settings.speed))
  form.append('pitch',  String(settings.pitch))
  form.append('volume', String(settings.volume))
  form.append('hf',     String(settings.highFrequencyReduction))
  form.append('bypassMode', String(settings.bypassMode))
  form.append('phaserAmount', String(settings.phaserAmount))
  form.append('vibratoAmount', String(settings.vibratoAmount))
  form.append('launderingLevel', settings.launderingLevel)
  form.append('silentDropouts', String(settings.silentDropouts))
  form.append('dropoutInterval', String(settings.dropoutInterval))
  form.append('dropoutDuration', String(settings.dropoutDuration))

  onProgress('Processing with ffmpeg — this may take 20–60 seconds for long files…')
  let response: Response
  try {
    response = await fetch(`${SERVER}/process`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(180_000), // 3 minute timeout
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Network error: ${msg}`)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const json = await response.json()
      detail = json.error ?? ''
    } catch { /* ignore */ }
    throw new Error(detail || `Server error ${response.status}`)
  }

  onProgress('Downloading processed MP3…')
  const blob = await response.blob()
  if (blob.size < 1000) throw new Error('Server returned an empty file. Check terminal for ffmpeg errors.')

  return blob
}