import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(),],
  // gtcrnInference.worker.ts pulls in onnxruntime-web, which Rollup code-splits. Vite's default
  // worker format ('iife') cannot emit a code-split bundle at all — the build fails outright
  // with "UMD and IIFE output formats are not supported for code-splitting builds" — so worker
  // output has to be ES modules. Both workers are already constructed with { type: 'module' }.
  worker: {
    format: 'es',
  },
})
