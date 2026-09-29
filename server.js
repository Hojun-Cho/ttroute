// Production server: the trace API plus the built site in dist/.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { trace } from './trace.js'

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
}

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x') // throws on targets like "//"
      if (pathname === '/api/trace') return trace(req, res)
      const file = join('dist', pathname === '/' ? 'index.html' : pathname)
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  .listen(process.env.PORT || 3000)
