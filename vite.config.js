import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Chrome compiles a script with this hint while it streams in, not each function on its first
// call: the list's code on the first tap, the world's in the worker's first reply.
const compiled = { output: { postBanner: '//# allFunctionsCalledOnLoad' } } // after minifying, which drops a plain banner

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
    {
      name: 'preload-world',
      apply: 'build',
      // The worker's script is most of the download: it starts with the page's own, not once that
      // has run, and the worker then takes it from the HTTP cache (server.js keeps /assets/ for good).
      transformIndexHtml: {
        order: 'post',
        handler: (html, { bundle }) => [{ tag: 'link', attrs: { rel: 'modulepreload', href: '/' + Object.keys(bundle).find(f => f.startsWith('assets/land-')) }, injectTo: 'head' }],
      },
    },
  ],
  build: { rollupOptions: compiled },
  worker: { rollupOptions: compiled },
})
