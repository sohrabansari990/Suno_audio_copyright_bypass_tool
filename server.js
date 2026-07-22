import express from 'express'
import multer from 'multer'
import cors from 'cors'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, readFile, unlink } from 'fs/promises'
import { join, extname } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { createServer as createViteServer } from 'vite'

const require = createRequire(import.meta.url)

// Use bundled ffmpeg — works on Windows, Mac, Linux without any installation
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
console.log(`✅ Using bundled ffmpeg: ${ffmpegPath}`)

const execFileAsync = promisify(execFile)

async function startServer() {
  const app = express()
  const PORT = 3000

  app.use(cors())
  app.use(express.json())

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 },
  })

  app.post('/process', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received.' })
    }

    const speed  = Math.max(0.25, Math.min(4,   parseFloat(req.body.speed  ?? '1')))
    const pitch  = Math.max(-12,  Math.min(12,  parseFloat(req.body.pitch  ?? '0')))
    const volume = Math.max(-60,  Math.min(6,   parseFloat(req.body.volume ?? '0')))
    const hf     = Math.max(0,    Math.min(100, parseFloat(req.body.hf     ?? '0')))

    // New degradation parameters to simulate unoptimized browser phase-vocoder & bypass fingerprinting
    const bypassMode = req.body.bypassMode === 'true'
    const phaserAmount = Math.max(0, Math.min(100, parseFloat(req.body.phaserAmount ?? '0')))
    const vibratoAmount = Math.max(0, Math.min(100, parseFloat(req.body.vibratoAmount ?? '0')))
    const launderingLevel = req.body.launderingLevel ?? 'none'
    const silentDropouts = req.body.silentDropouts === 'true'
    const dropoutInterval = Math.max(2, Math.min(30, parseFloat(req.body.dropoutInterval ?? '8')))
    const dropoutDuration = Math.max(0.1, Math.min(5, parseFloat(req.body.dropoutDuration ?? '0.6')))

    // Build pitch shift + time stretch filter chain
    const pitchRatio = Math.pow(2, pitch / 12)
    const tempo      = speed / pitchRatio

    // FFmpeg atempo only accepts 0.5–2.0 per instance — chain for extreme values
    const atempoFilters = []
    let remaining = tempo
    while (remaining < 0.5)  { atempoFilters.push('atempo=0.5'); remaining /= 0.5 }
    while (remaining > 2.0)  { atempoFilters.push('atempo=2.0'); remaining /= 2.0 }
    atempoFilters.push(`atempo=${remaining.toFixed(7)}`)

    const filters = [
      'aresample=44100',
      `asetrate=r=44100*${pitchRatio.toFixed(7)}`,
      ...atempoFilters,
      'aresample=44100',
    ]
    if (volume !== 0) filters.push(`volume=${volume}dB`)
    if (hf > 0)       filters.push(`lowpass=f=${Math.max(3500, Math.round(20000 - hf * 155))}`)

    // If bypass mode is active, inject phase-smearing phaser and vibrato pitch warbles
    if (bypassMode) {
      if (phaserAmount > 0) {
        const delay = 1.0 + (phaserAmount / 100) * 4.0
        const speedHz = 0.1 + (phaserAmount / 100) * 2.5
        const decay = 0.2 + (phaserAmount / 100) * 0.55
        filters.push(`aphaser=in_gain=0.6:out_gain=0.8:delay=${delay.toFixed(1)}:decay=${decay.toFixed(2)}:speed=${speedHz.toFixed(2)}:type=triangular`)
      }
      if (vibratoAmount > 0) {
        const vibFreq = 2.0 + (vibratoAmount / 100) * 8.0
        const vibDepth = (vibratoAmount / 100) * 0.12
        filters.push(`vibrato=f=${vibFreq.toFixed(1)}:d=${vibDepth.toFixed(3)}`)
      }
      if (silentDropouts) {
        // Use a tiny minimum volume of 0.0001 (-80dB) instead of 0 to prevent libmp3lame psymodel.c:calc_energy assertion crash on absolute silence
        filters.push(`volume='if(lt(mod(t,${dropoutInterval}),${dropoutDuration}),0.0001,1)':eval=frame`)
      }
    }

    let outputSampleRate = '44100'
    let outputBitrate = '192k'
    let outputChannels = null

    if (bypassMode) {
      if (launderingLevel === 'medium') {
        outputSampleRate = '22050'
        outputBitrate = '64k'
        outputChannels = '2'
      } else if (launderingLevel === 'severe') {
        outputSampleRate = '22050'
        outputBitrate = '32k'
        outputChannels = '2'
      } else if (launderingLevel === 'extreme') {
        outputSampleRate = '16000'
        outputBitrate = '24k'
        outputChannels = '1'
      }
    }

    // Final resample and channel layout downmix inside the filter chain, BEFORE applying dither.
    // This ensures no automatic resampling/downmixing occurs AFTER the dither filter, which
    // would otherwise filter out the dither noise and cause LAME's psymodel to crash with el >= 0.
    if (outputChannels) {
      filters.push(`aformat=sample_rates=${outputSampleRate}:channel_layouts=${outputChannels === '1' ? 'mono' : 'stereo'}`)
    } else {
      filters.push(`aformat=sample_rates=${outputSampleRate}`)
    }

    // Always append a tiny, completely inaudible white noise floor (-90dB) at the very end of the filter chain.
    // Also sanitizes any potential NaN or Infinity sample values produced by earlier floating-point-heavy filters
    // (such as vibrato, aphaser, atempo) to 0 before applying dither. This acts as a robust fail-safe preventing
    // libmp3lame psymodel.c:calc_energy assertion crash.
    filters.push("aeval=exprs='if(isnan(val(ch))+isinf(val(ch)),0,val(ch))+0.00003*(random(0)-0.5)'")

    const id      = randomBytes(8).toString('hex')
    const ext     = extname(req.file.originalname) || '.mp3'
    const inPath  = join(tmpdir(), `in_${id}${ext}`)
    const outPath = join(tmpdir(), `out_${id}.mp3`)

    try {
      await writeFile(inPath, req.file.buffer)

      const args = [
        '-y', '-i', inPath,
        '-vn',
      ]

      if (outputChannels) {
        args.push('-ac', outputChannels)
      }

      args.push(
        '-af', filters.join(','),
        '-c:a', 'libmp3lame',
        '-b:a', outputBitrate,
        '-ar', outputSampleRate,
        outPath,
      )

      console.log(`[${id}] speed=${speed} pitch=${pitch}st hf=${hf}% bypassMode=${bypassMode} phaserAmount=${phaserAmount}% vibratoAmount=${vibratoAmount}% silentDropouts=${silentDropouts} laundering=${launderingLevel}`)
      console.log(`[${id}] filters: ${filters.join(',')}`)

      await execFileAsync(ffmpegPath, args, { timeout: 180_000 })

      const result = await readFile(outPath)
      res.set('Content-Type', 'audio/mpeg')
      res.set('Content-Disposition', 'attachment; filename="processed.mp3"')
      res.send(result)

      console.log(`[${id}] Done — ${(result.length / 1024).toFixed(0)} KB`)

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${id}] Error:`, msg)
      res.status(500).json({ error: msg || 'ffmpeg processing failed.' })
    } finally {
      await Promise.allSettled([unlink(inPath), unlink(outPath)])
    }
  })

  app.get('/health', (_req, res) => res.json({ ok: true }))

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎵 Server ready at http://0.0.0.0:${PORT}\n`)
  })
}

startServer()
