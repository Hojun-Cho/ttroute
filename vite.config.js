import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'trace-api',
      // Imported only by the dev server: building the site needs no location data.
      configureServer: async s => {
        const { trace } = await import('./trace.js')
        s.middlewares.use('/api/trace', trace)
      },
    },
  ],
  build: { chunkSizeWarningLimit: 1000 }, // the 1:50m world map is most of it
})
