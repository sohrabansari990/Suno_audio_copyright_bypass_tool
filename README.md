# Aura Audio

A browser-first React audio editor for recordings, demos, stems, and other audio you own or are authorized to edit.

## Features

- Drag-and-drop audio input with original-audio preview (MP3, WAV, M4A, OGG, FLAC, AAC, WMA, AIFF, OPUS, WEBM, and MP4 containers)
- Independent speed and pitch controls
- Output-gain and high-frequency-reduction controls
- Local 192 kbps MP3 rendering and download
- Accessible keyboard controls, responsive layout, reduced-motion support, and clear processing states

The editor uses `ffmpeg.wasm` in the browser. Audio is processed in local browser memory; no application server receives the audio file. The processing engine ships with the app, so it is not fetched from an external CDN during rendering.

This project is for legitimate audio editing only. It does not claim to bypass third-party copyright checks, content matching, or platform policies.

## Run locally

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The resulting `dist/` directory is static and can be deployed to Cloudflare Pages, Vercel, Netlify, or another static host.
