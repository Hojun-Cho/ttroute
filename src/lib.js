import { geoDistance } from 'd3-geo'

const EARTH_KM = 6371
const SAME_PLACE_KM = 15 // the DB often gives one city several points a few km apart
const NEAR_MS = 3 // a hop this little slower than a placed one is within ~300 km of it

export const ll = p => [p.lon, p.lat]
export const km = (a, b) => geoDistance(ll(a), ll(b)) * EARTH_KM

// Light in fiber covers about 100 km per millisecond of round trip. The probe
// passed `via`, the last hop placed, and the reply came back at best straight,
// so a place farther than that loop allows is anycast or mislocated.
export const reachKm = ms => ms * 100 + 300 // slack for DB error at the source
const fits = (p, ms, source, via) =>
  source?.lat == null || km(source, via) + km(via, p) + km(p, source) <= 2 * reachKm(ms)
export const tooFar = (r, source, via) => r.lat != null && !fits(r, Math.min(...r.ms), source, via)

// place returns where a reply came from, from the best source its RTT allows:
// for an anycast address, the site that answered; else the city in the
// router's host name, RIPE IPmap's measurements, the database.
export function place(r, name, source, via) {
  const ms = Math.min(...r.ms)
  // An anycast address answers from its site nearest the path, which is
  // taken to be the known site nearest the last hop placed that fits the RTT.
  if (r.anycast && via) {
    const site = r.anycast
      .map(([city, cc, lat, lon]) => ({ city, cc, lat, lon }))
      .filter(p => fits(p, ms, source, via))
      .sort((a, b) => km(via, a) - km(via, b))[0]
    if (site) return { ...site, from: `anycast, 1 of ${r.anycast.length} sites` }
  }
  if (name?.place && fits(name.place, ms, source, via)) return { ...name.place, from: 'host name' }
  if (r.ipmap && fits(r.ipmap, ms, source, via)) return { ...r.ipmap, from: 'RIPE IPmap' }
  // The database misplaces backbone routers often enough that its city must also be
  // reachable in the time added since the last hop placed, not only from the source.
  if (r.lat != null && fits(r, ms, source, via) && (!via || km(via, r) <= reachKm(Math.max(0, ms - (via.ms ?? 0)))))
    return { city: city(r), cc: r.cc, lat: r.lat, lon: r.lon, from: 'database' }
  return null
}

export const rtt = hop => {
  const ms = hop.replies.flatMap(r => r.ms)
  return ms.length ? Math.min(...ms) : null
}

// locate returns each hop's place, in hop order: a reply's host name or database
// city when its RTT allows, else, if the hop answered barely later than the
// last hop placed that way, near that one. Estimates never anchor others.
export function locate(source, hops, names) {
  let last = source?.lat != null ? { city: city(source), cc: source.cc, lat: source.lat, lon: source.lon, n: 0, ms: 0 } : null
  return hops.map(h => {
    for (const r of h.replies) {
      const p = place(r, names[r.ip], source, last)
      if (p) return (last = { ...p, n: h.n, ms: Math.min(...r.ms) })
    }
    const ms = rtt(h)
    return ms != null && last && ms - last.ms <= NEAR_MS ? { ...last, near: true, lag: Math.max(0, ms - last.ms) } : null
  })
}

// route lists the places a packet passes, in order, starting at the source.
// Consecutive hops in the same place share one stop; d is radians travelled so far.
export function route(source, spots) {
  const stops = []
  const visit = (p, n) => {
    const last = stops.at(-1)
    if (last && km(last, p) < SAME_PLACE_KM) return last.hops.push(n)
    const d = last ? last.d + geoDistance(ll(last), ll(p)) : 0
    stops.push({ lat: p.lat, lon: p.lon, city: city(p), hops: [n], d })
  }
  if (source?.lat != null) visit(source, 0)
  spots.forEach((p, i) => p && visit(p, i + 1))
  return stops
}

export const city = p => p.city?.replace(/\s*\(.*\)$/, '')
export const fmt = ms => (ms == null ? '—' : ms < 10 ? ms.toFixed(1) : String(Math.round(ms)))
export const num = n => Math.round(n).toLocaleString('en-US')
