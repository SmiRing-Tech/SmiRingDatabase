// Copies the runtime assets @ricky0123/vad-web loads by URL — its AudioWorklet
// bundle and the Silero ONNX model — into public/vad/, so Vite serves them as
// static files in both dev and build.
//
// These are fetched at runtime rather than imported, so the bundler never sees
// them. vite-plugin-static-copy is the usual answer, but its dev middleware
// lands after the SPA fallback on Vite 7 and every asset comes back as
// index.html. public/ is Vite's own static directory and needs no plugin. The
// directory is gitignored — this script repopulates it from node_modules, so
// it always matches the installed package version.
//
// onnxruntime-web's own wasm is deliberately NOT copied here: it's imported
// with ?url in ConnectRoomPage.tsx so the bundler emits it. Vite refuses to
// serve public/ files as modules, which breaks ORT's dynamic import of its
// wasm loader.
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'public', 'vad')

const files = [
  'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
]

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

for (const rel of files) {
  await cp(join(root, rel), join(outDir, rel.split('/').pop()))
}

console.log(`[copy-vad-assets] copied ${files.length} files to public/vad/`)
