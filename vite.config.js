import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { trace } from './trace.js'

export default defineConfig({
  plugins: [
    svelte(),
    { name: 'trace-api', configureServer: s => void s.middlewares.use('/api/trace', trace) },
  ],
  build: { chunkSizeWarningLimit: 1000 }, // the 1:50m world map is most of it
})
