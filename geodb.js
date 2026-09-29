// Fetches the location data into data/: DB-IP's city and network databases
// (monthly), RIPE IPmap's measured router locations (daily), packed as records
// sorted by address for binary search, and the LACeS census of anycast
// prefixes with their sites (daily). DB-IP is required; the other two only
// sharpen placement, so when their sites are down the server runs without them.
import { execSync } from 'node:child_process'
import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { key } from './ip.js'

const MIN_SCORE = 20 // below this, IPmap was over 1,000 km off about half the time
const MIN_ROWS = 900_000 // some daily dumps are partial; a full one has about 1.05 million

mkdirSync('data', { recursive: true })
// curl -f writes nothing on failure, so a failed download never replaces a working file.
const get = (url, file) => execSync(`curl -sfo ${file} ${url}`)

// DB-IP publishes on the 1st; until then, last month's file is the latest.
const now = new Date()
const months = [0, 1].map(back => new Date(now.getFullYear(), now.getMonth() - back, 15).toISOString().slice(0, 7))
for (const db of ['city', 'asn']) {
  const url = m => `https://download.db-ip.com/free/dbip-${db}-lite-${m}.mmdb.gz`
  try {
    get(url(months[0]), `data/dbip-${db}-lite.mmdb.gz`)
  } catch {
    get(url(months[1]), `data/dbip-${db}-lite.mmdb.gz`)
  }
  execSync(`gunzip -f data/dbip-${db}-lite.mmdb.gz`)
}

for (const [name, run] of [
  ['IPmap', ipmap],
  ['Anycast census', census],
]) {
  try {
    console.log(`${name}: ${await run()}`)
  } catch (e) {
    console.warn(`${name}: ${e.message.split('\n')[0]}; skipped`)
  }
}

async function ipmap() {
  get('https://ftp.ripe.net/ripe/ipmap/geolocations-latest', 'data/ipmap.csv.bz2')
  execSync('bunzip2 -f data/ipmap.csv.bz2')

  // Rows are ip/len,id,city,state,country,cc2,cc3,lat,lon,score. Some country
  // names hold commas, so the numbers are read from the right.
  const records = []
  const places = new Map() // "city,cc" -> index
  let rows = 0
  for await (const line of createInterface({ input: createReadStream('data/ipmap.csv') })) {
    rows++
    const f = line.split(',')
    const [lat, lon, score] = f.slice(-3)
    if (!lat || !lon || !(+score >= MIN_SCORE)) continue
    const place = [f[2], f.at(-5)].join(',')
    if (!places.has(place)) places.set(place, places.size)
    records.push([key(f[0].split('/')[0]), +lat, +lon, places.get(place)])
  }
  rmSync('data/ipmap.csv')
  if (rows < MIN_ROWS) throw new Error(`the dump has only ${rows} rows, so it is partial`)

  // One file per address size: [address, lat, lon, place] records, sorted by address.
  for (const [size, file] of [[4, 'ipmap4.bin'], [16, 'ipmap6.bin']]) {
    const rs = records.filter(r => r[0].length === size).sort((a, b) => Buffer.compare(a[0], b[0]))
    const buf = Buffer.alloc(rs.length * (size + 12))
    rs.forEach(([k, lat, lon, p], i) => {
      const o = i * (size + 12)
      k.copy(buf, o)
      buf.writeFloatBE(lat, o + size)
      buf.writeFloatBE(lon, o + size + 4)
      buf.writeUInt32BE(p, o + size + 8)
    })
    writeFileSync(`data/${file}`, buf)
  }
  writeFileSync('data/ipmap-places.json', JSON.stringify([...places.keys()].map(p => p.split(','))))
  return `${records.length} of ${rows} addresses kept (score >= ${MIN_SCORE})`
}

// LACeS lists IPv4 /24 and IPv6 /48 prefixes that are anycast, each with the
// sites it was seen at. Kept: the census's "high confidence" rule. Sites are
// airports, so each is stored once and prefixes point at shared lists of them.
function census() {
  const sites = new Map() // "city,cc,lat,lon" -> index
  const lists = new Map() // "i,j,k" -> index
  const prefixes = {}
  for (const v of ['v4', 'v6']) {
    get(`https://manycast.net/api/v1/export/IP${v}-latest.json.gz`, `data/anycast-${v}.json.gz`)
    execSync(`gunzip -f data/anycast-${v}.json.gz`)
    for (const line of readFileSync(`data/anycast-${v}.json`, 'utf8').split('\n')) {
      if (!line) continue
      const p = JSON.parse(line)
      const n = key => p[`${key}${v}`] ?? 0
      if (Math.max(n('AB_ICMP'), n('AB_TCP'), n('AB_DNS')) <= 3 && Math.max(n('GCD_ICMP'), n('GCD_TCP')) <= 1) continue
      const ids = (p.locations ?? []).filter(s => s.city).map(s => {
        const site = [s.city, s.country_code, s.lat, s.lon].join(',')
        if (!sites.has(site)) sites.set(site, sites.size)
        return sites.get(site)
      })
      if (!ids.length) continue
      const list = ids.join(',')
      if (!lists.has(list)) lists.set(list, lists.size)
      prefixes[p.prefix] = lists.get(list)
    }
    rmSync(`data/anycast-${v}.json`)
  }
  writeFileSync(
    'data/anycast.json',
    JSON.stringify({
      sites: [...sites.keys()].map(s => s.split(',').map((x, i) => (i > 1 ? +x : x))),
      lists: [...lists.keys()].map(l => l.split(',').map(Number)),
      prefixes,
    }),
  )
  return `${Object.keys(prefixes).length} prefixes, ${sites.size} sites`
}
