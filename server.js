// Production server: the trace API plus the built site in dist/.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { trace } from './trace.js'

const gz = promisify(gzip) // off the event loop, which streams other visitors' hops
// Vite puts a content hash in every name under /assets/, so browsers may keep
// those files for good, and each needs compressing only once.
const zipped = {}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
}

const server = http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x') // throws on targets like "//"
      if (pathname === '/api/trace') return trace(req, res)
      const file = join('dist', pathname === '/' ? 'index.html' : pathname)
      const body = await readFile(file)
      const zip = /\bgzip\b/.test(req.headers['accept-encoding'])
      const asset = pathname.startsWith('/assets/')
      const out = zip ? await (asset ? (zipped[file] ??= gz(body)) : gz(body)) : body
      res
        .writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
          vary: 'accept-encoding',
          ...(zip && { 'content-encoding': 'gzip' }),
          ...(asset && { 'cache-control': 'public, max-age=31536000, immutable' }),
        })
        .end(out)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  .listen(process.env.PORT || 3000)

// As PID 1 in the container, node ignores SIGTERM unless it handles it.
process.on('SIGTERM', () => server.close())
