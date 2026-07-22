import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('node_modules/@ffmpeg/core/dist/umd')
const destination = resolve('public/ffmpeg')

await mkdir(destination, { recursive: true })
await Promise.all([
  copyFile(resolve(source, 'ffmpeg-core.js'), resolve(destination, 'ffmpeg-core.js')),
  copyFile(resolve(source, 'ffmpeg-core.wasm'), resolve(destination, 'ffmpeg-core.wasm')),
])
