// Runs traceroute toward a host and streams each hop as a server-sent event.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Resolver } from 'node:dns/promises'
import { createInterface } from 'node:readline'
import { connect, isIP } from 'node:net'
import { Reader } from 'mmdb-lib'
import places from './places.js'
import { block, key } from './ip.js'

const cities = new Reader(readFileSync('data/dbip-city-lite.mmdb'))
const networks = new Reader(readFileSync('data/dbip-asn-lite.mmdb'))
// IPmap and the anycast census are optional (see geodb.js); without them, placement uses the database.
const optional = (file, none) => (existsSync(file) ? readFileSync(file) : none)
const ipmap = { 4: optional('data/ipmap4.bin', Buffer.alloc(0)), 16: optional('data/ipmap6.bin', Buffer.alloc(0)) }
const ipmapPlaces = JSON.parse(optional('data/ipmap-places.json', '[]'))
const anycast = JSON.parse(optional('data/anycast.json', '{"prefixes":{}}'))
const dns = new Resolver({ timeout: 1000, tries: 1 })

const PROBES = 3 // per hop
const MAX_SILENT = 8 // give up after this many silent hops in a row; clouds like Azure hide ~7

// Every trace starts here, so the map needs to know where "here" is. An error page is
// not an address, and a lookup that failed at startup is tried again by later traces.
const lookup = () =>
  fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })
    .then(r => r.text())
    .then(ip => (isIP(ip) ? ip : null), () => null)
let self = process.env.SELF_IP || (await lookup())

function geo(ip) {
  const c = cities.get(ip)
  const [a, len] = networks.getWithPrefixLength(ip)
  const kind = SPECIAL.find(([b]) => block(ip, +b.split('/')[1]).net === b)?.[1] ?? 'public'
  // Without a record, len is only where the DB's tree ran out, not a network.
  const { net, mask } = a || kind !== 'public' ? block(ip, len) : {}
  return {
    ip,
    city: c?.city?.names.en,
    country: c?.country?.names.en,
    cc: c?.country?.iso_code,
    lat: c?.location?.latitude,
    lon: c?.location?.longitude,
    asn: a?.autonomous_system_number,
    org: a?.autonomous_system_organization,
    net, // the address block the ASN database has for it
    mask,
    kind,
    ipmap: kind === 'public' ? measured(ip) : undefined, // the dump also lists private addresses, at random cities
  }
}

// sitesOf returns the sites an anycast address answers from, as [city, cc, lat, lon].
function sitesOf(ip) {
  const list = anycast.prefixes[block(ip, ip.includes(':') ? 48 : 24).net]
  return list === undefined ? undefined : anycast.lists[list].map(i => anycast.sites[i])
}

// measured returns where RIPE IPmap's latency measurements put an address:
// a binary search over the records geodb.js packed.
function measured(ip) {
  const k = key(ip)
  const buf = ipmap[k.length]
  const size = k.length + 12
  let lo = 0
  let hi = buf.length / size - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = Buffer.compare(buf.subarray(mid * size, mid * size + k.length), k)
    if (c < 0) lo = mid + 1
    else if (c > 0) hi = mid - 1
    else {
      const o = mid * size + k.length
      const [city, cc] = ipmapPlaces[buf.readUInt32BE(o + 8)]
      return { city, cc, lat: buf.readFloatBE(o), lon: buf.readFloatBE(o + 4) }
    }
  }
}

// Blocks that never route on the public internet.
const SPECIAL = [
  ['0.0.0.0/8', 'this network'],
  ['10.0.0.0/8', 'private'],
  ['172.16.0.0/12', 'private'],
  ['192.168.0.0/16', 'private'],
  ['100.64.0.0/10', 'carrier-grade NAT'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['fc00::/7', 'private'],
  ['fe80::/10', 'link-local'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
]

const codes = new Map(
  Object.entries(places).flatMap(([keys, [city, cc, lat, lon]]) => keys.split(' ').map(k => [k, { city, cc, lat, lon }])),
)

// Common interface names and router roles in carriers' host names.
const PORTS = [
  [/^(be|bundle-ether|ae|po|port-?channel)-?\d/, 'bundled link'],
  [/^(hu|hundredgige|100ge)-?\d/, '100G port'],
  [/^et-?\d/, '40/100G port'],
  [/^(fo|fortygige|40ge)-?\d/, '40G port'],
  [/^(te|tengige|xe|10ge)-?\d/, '10G port'],
  [/^(gi|ge|gigabitethernet)-?\d/, '1G port'],
  [/^(vl|vlan|irb|bvi|ve)-?\d/, 'VLAN interface'],
  [/^(lo|loopback)-?\d/, 'loopback'],
]
const ROLES = [
  [/^(core|ccr|rcr|cr)\d/, 'core router'],
  [/^(edge|er|pe)\d/, 'edge router'],
  [/^(br|border)\d/, 'border router'],
  [/^(bb|backbone)\d/, 'backbone router'],
  [/^(agg|ag)\d/, 'aggregation router'],
]

// hint reads a router's host name, e.g. "be3050.rcr71.tyo01.atlas.cogentco.com":
// its last city code (labels run from port to metro, and an earlier site code
// like Telstra's stl or lon can clash), and what kind of router and port it is.
function hint(host) {
  // not the domain, which may be anything, nor DFN's network name "x-win", which isn't Vienna
  const labels = host.toLowerCase().split('.').slice(0, -2).filter(l => l !== 'x-win')
  const tokens = labels.flatMap(l => l.split('-'))
  const place = tokens.map(t => codes.get(t.replace(/\d+$/, ''))).findLast(Boolean)
  const role = ROLES.find(([re]) => tokens.some(t => re.test(t)))?.[1]
  const port = PORTS.find(([re]) => re.test(labels[0] ?? ''))?.[1]
  return { place, device: [role, port].filter(Boolean).join(' · ') || undefined }
}

// handshake times one TCP connection to port 443, or returns null if nothing answers.
// A refusal counts as an answer: something at that address replied.
const handshake = ip =>
  new Promise(done => {
    const t0 = performance.now()
    const s = connect({ host: ip, port: 443, timeout: 3000 })
    const end = answered => {
      s.destroy()
      done(answered ? performance.now() - t0 : null)
    }
    s.on('connect', () => end(true))
    s.on('error', e => end(e.code === 'ECONNREFUSED'))
    s.on('timeout', () => end(false))
  })

const clientIP = req =>
  (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress).replace(/^::ffff:/, '')

export function trace(req, res) {
  if (!self) lookup().then(ip => (self ||= ip))
  const me = clientIP(req)
  const to = new URL(req.url, 'http://x').searchParams.get('to') || me

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  const send = (event, data) => res.writableEnded || res.destroyed || res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  send('start', { source: self && geo(self), me: to === me })
  if (!/^[\w.:-]+$/.test(to) || to[0] === '-') {
    send('end', { error: 'Not a host or IP address.' }) // the page already shows what was typed
    return res.end()
  }

  // ICMP probes (-I) get much further than UDP ones; Linux needs CAP_NET_RAW for them.
  // On Linux, -w is MAX,HERE,NEAR: a lost probe waits 3× (RTT + 1 ms) of a reply from
  // its hop, or 30× that of a later hop, not the full second that holds back
  // every line after it ("-w 1" alone turns that off). Not the default 10×: Linode's
  // gateway can answer in 30 ms while the hop after it answers in 0.3 ms. macOS takes one number.
  const wait = process.platform === 'linux' ? '1,3,30' : 1
  const args = ['-I', '-n', '-q', PROBES, '-w', wait, '-m', 30, to].map(String)
  const p = spawn(to.includes(':') ? 'traceroute6' : 'traceroute', args)
  res.on('close', () => p.kill())

  let hop, dest, silent = 0, err = ''
  const named = new Set()
  const lookups = []

  // macOS prints this line to stderr, Linux to stdout.
  const header = line => {
    const m = line.match(/^traceroute6? to (\S+) \(([^)]+)\)/)
    if (m && geo(m[2]).kind !== 'public') {
      // A private or local address would trace the server's own network, not the internet.
      send('end', { error: 'Not a public address.' })
      res.end() // 'close' stops traceroute
    } else if (m) {
      send('target', { ...geo((dest = m[2])), anycast: sitesOf(dest) })
      lookups.push(knock(dest))
    }
    return m
  }

  // Many sites drop probes but must answer web traffic, so handshakes on port
  // 443, alongside the trace, show whether the destination is there and its
  // round trip (the best of three).
  const knock = async ip => {
    let best
    for (let i = 0; i < 3; i++) {
      const ms = await handshake(ip)
      if (ms == null) break
      best = Math.min(best ?? ms, ms)
    }
    if (best != null) send('tcp', { port: 443, ms: best })
  }

  const name = ip => {
    if (named.has(ip)) return
    named.add(ip)
    lookups.push(dns.reverse(ip).then(([host]) => host && send('name', { ip, host, ...hint(host) }), () => {}))
  }

  // A hop is " 5  1.2.3.4  5.6 ms  5.2 ms  *"; routers that share a hop
  // either follow on the same line or on indented lines of their own.
  const parse = line => {
    // macOS appends send errors ("traceroute: wrote ...") to hop lines.
    const t = line.replace(/traceroute6?:.*/, '').trim().split(/\s+/)
    if (/^\d+$/.test(t[0])) hop = { n: +t.shift(), sent: 0, replies: [] }
    if (!hop) return
    let r
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '*') hop.sent++
      else if (t[i + 1] === 'ms') r?.ms.push(+t[i++]), hop.sent++
      else if (isIP(t[i])) {
        r = hop.replies.find(x => x.ip === t[i])
        // Routers answer from their own addresses, so the anycast census only fits the destination.
        if (!r) hop.replies.push((r = { ...geo(t[i]), anycast: t[i] === dest ? sitesOf(dest) : undefined, ms: [] }))
        name(t[i])
      }
    }
    send('hop', hop)
    if (hop.sent === PROBES) {
      silent = hop.replies.length ? 0 : silent + 1
      if (silent === MAX_SILENT) p.kill()
    }
  }

  createInterface({ input: p.stderr }).on('line', l => header(l) || (err += l + '\n'))
  createInterface({ input: p.stdout }).on('line', l => header(l) || parse(l))
  p.on('error', e => (err = e.message)) // traceroute missing; 'close' still follows
  p.on('close', async code => {
    await Promise.all(lookups) // the destination's name resolves after traceroute exits
    const reached = !!hop?.replies.some(r => r.ip === dest)
    // The pod network has no IPv6, so traceroute can't open a socket toward an IPv6 address.
    if (err.includes('Network is unreachable')) err = 'This server cannot trace IPv6.'
    // Linux starts with the host ("x.invalid: Name or service not known"), which the page already shows.
    if (err.includes('Name or service not known')) err = 'No such host.'
    // The first line says what went wrong; Linux adds one about its argument parser.
    send('end', { reached, error: code && !hop ? err.trim().split('\n')[0] || 'traceroute failed' : undefined })
    res.end()
  })
}
