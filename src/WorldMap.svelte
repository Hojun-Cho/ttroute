<script>
  import { untrack } from 'svelte'
  import { geoNaturalEarth1, geoPath, geoGraticule10, geoInterpolate, geoDistance } from 'd3-geo'
  import { feature, mesh } from 'topojson-client'
  import { Spring } from 'svelte/motion'
  import { cubicInOut, sineInOut, backOut } from 'svelte/easing'
  import world from 'world-atlas/countries-50m.json'
  import { ll, city } from './lib.js'

  let { source, target, stops, run, selected = $bindable(), hovered = $bindable() } = $props()

  const sphere = { type: 'Sphere' }
  const land = feature(world, world.objects.land)
  const borders = mesh(world, world.objects.countries, (a, b) => a !== b)
  const graticule = geoGraticule10()
  const W = 1000 // projected width of the world, in map units
  const ZOOM = [Math.log(1), Math.log(2500)] // limits of log(view width)
  const REGION = Math.log(45) // how close a selected hop is shown

  let w = $state(0)
  let h = $state(0)

  // Centered on the server, so routes leaving it rarely cross the map's edge; but routes
  // to places 110–180° west of it mostly go the other way round, over the Americas, so
  // those center 110° east of it. Projecting the world takes a long frame, so only a
  // target that needs the other center moves it, and nothing is drawn until one is known.
  let lon = $state(null)
  $effect(() => {
    const s = source?.lon ?? 0
    const t = run.target
    const west = t && (s - t.lon + 360) % 360
    const to = t ? (!t.anycast && west > 110 && west <= 180 ? s + 110 : s) : (lon ?? (run.status === 'tracing' ? null : s))
    if (to !== lon) untrack(() => recenter(to))
  })
  let projection = $derived(geoNaturalEarth1().rotate([-(lon ?? 0), 0]).fitWidth(W, sphere))
  let path = $derived(geoPath(projection))
  let base = $derived(lon != null && { sphere: path(sphere), graticule: path(graticule), land: path(land), borders: path(borders) })
  let bounds = $derived(path.bounds(sphere))
  const xy = p => projection(Array.isArray(p) ? p : ll(p))
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))

  // The camera is [x, y, z]: the view's center in map units and the log of its
  // width. Zoom in log space moves at an even pace, and the view box is derived
  // from the stage's size, so it always matches the stage's shape.
  // The spring settles in about 350 ms, without overshoot at any frame rate.
  const camera = new Spring(undefined, { stiffness: 0.3, damping: 0.95 })
  let view = $derived.by(() => {
    if (!camera.current || !w) return null
    const [x, y, z] = camera.current
    const vw = Math.exp(z)
    return [x - vw / 2, y - (vw * h) / w / 2, vw, (vw * h) / w]
  })
  let k = $derived(view ? view[2] / w : 1) // map units per px

  // Until the reader moves the map, it frames the route and destination, or the
  // world before there is one. A destination with no place yet (anycast before it
  // answers, or one the database or port 443 can't place) keeps the world in view:
  // the route alone can fold back into the server's city as names move its hops,
  // and the view would swing in and out.
  let manual = $state(false)
  let frame = $derived.by(() => {
    const pts = (target ? [...stops, target] : run.status === 'tracing' ? [] : stops).map(xy)
    const [[x0, y0], [x1, y1]] =
      pts.length > 1
        ? [[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]]
        : bounds
    const pad = pts.length > 1 ? 1.7 : 1.02
    const [[wx0, wy0], [wx1, wy1]] = bounds
    const vw = Math.min(Math.max((x1 - x0) * pad, ((y1 - y0) * pad * w) / h, 70), (wx1 - wx0) * 1.02)
    const vh = (vw * h) / w
    // Keep the view over the world where it fits, instead of showing the void around it.
    const keep = (c, size, lo, hi) => (size >= hi - lo ? (lo + hi) / 2 : clamp(c, lo + size / 2, hi - size / 2))
    return [keep((x0 + x1) / 2, vw, wx0, wx1), keep((y0 + y1) / 2, vh, wy0, wy1), Math.log(vw)]
  })
  $effect(() => {
    const f = frame // read first, so the view keeps following the route after a flight lands
    if (w && h && !manual && !flight) camera.set(f) // the first set is instant
  })

  // fit flies back to the frame, as a selection does, instead of springing across the map from close in.
  function fit() {
    const [x, y, z] = camera.current
    fling = null
    flight = Math.hypot(frame[0] - x, frame[1] - y) < k ? null : { ...fly([x, y, Math.exp(z)], [frame[0], frame[1], Math.exp(frame[2])]), to: frame }
    manual = false
  }

  // recenter turns the world to a new center: a reader looking at a place keeps
  // looking at it, and a flight planned on the old map ends.
  function recenter(to) {
    const at = manual && lon != null && projection.invert(camera.current)
    lon = to
    flight = null
    if (at) camera.set([...projection(at), camera.current[2]], { instant: true })
  }

  // around returns the stops a hop sits among: [before, at, after] for a placed
  // hop, and for one that isn't (silent or mislocated) the placed hops either side.
  function around(n) {
    const i = stops.findIndex(s => s.hops.includes(n))
    if (i >= 0) return stops.slice(Math.max(0, i - 1), i + 2)
    const a = stops.findLastIndex(s => s.hops.some(h => h < n))
    const b = stops.findIndex(s => s.hops.some(h => h > n))
    return a < 0 ? [] : stops.slice(a, b < 0 ? a + 1 : b + 1)
  }

  // Selecting a hop, here or in the list, flies to where it is, or for a hop
  // that isn't placed, to the last place the route was seen before it,
  // close enough that its nearest neighbor sits at least 60 px away.
  // goal is a string so that the effect re-runs only when a late host name moves
  // the hop, not on every new hop, which would pull back a reader who panned away.
  let goal = $derived.by(() => {
    const near = selected ? around(selected) : []
    const s = near.find(s => s.hops.includes(selected)) ?? near[0]
    return s && `${s.lon} ${s.lat}`
  })
  $effect(() => {
    const n = selected
    goal
    untrack(() => {
      const near = n ? around(n) : []
      const s = near.find(s => s.hops.includes(n)) ?? near[0]
      if (!s || s === flight?.s) return // already on the way there; a new trip would start from rest
      const [x, y] = xy(s)
      const gap = Math.min(...near.filter(o => o !== s).map(o => Math.hypot(xy(o)[0] - x, xy(o)[1] - y)))
      // mid-flight, camera.target is where the flight is, not where it lands
      const z = clamp(Math.min(flight?.to[2] ?? camera.target[2], REGION, Math.log((gap * w) / 60)), ...ZOOM)
      const [cx, cy, cz] = camera.current
      if (Math.hypot(x - cx, y - cy) < k) return look([x, y, z], false) // no trip, only a zoom
      look(camera.current) // stops a fling, a spring move or an earlier flight
      flight = { ...fly([cx, cy, Math.exp(cz)], [x, y, Math.exp(z)]), to: [x, y, z], s }
    })
  })

  // fly returns the way from view a to view b, each [x, y, width]: out as far as
  // the trip needs and back in, at an even pace on screen, so a far hop doesn't
  // slide past at close zoom (van Wijk and Nuij's path, as in d3's interpolateZoom).
  // at(s) is the view at s along it, from 0 to its length S.
  function fly([x0, y0, w0], [x1, y1, w1]) {
    const [dx, dy] = [x1 - x0, y1 - y0]
    const d = Math.hypot(dx, dy)
    const b = (w, dd) => (w1 * w1 - w0 * w0 + dd) / (4 * w * d)
    const r0 = -Math.asinh(b(w0, 4 * d * d))
    const S = (-Math.asinh(b(w1, -4 * d * d)) - r0) / Math.SQRT2
    const at = s => {
      const r = Math.SQRT2 * s + r0
      const u = (w0 / (2 * d)) * (Math.cosh(r0) * Math.tanh(r) - Math.sinh(r0))
      return [x0 + u * dx, y0 + u * dy, (w0 * Math.cosh(r0)) / Math.cosh(r)]
    }
    return { at, S }
  }

  // look moves the camera for the reader, keeping the view's center over the world.
  function look([x, y, z], instant = true) {
    manual = true
    fling = flight = null
    const [[x0, y0], [x1, y1]] = bounds
    camera.set([clamp(x, x0, x1), clamp(y, y0, y1), clamp(z, ...ZOOM)], { instant })
  }

  const pan = (dx, dy) => look([camera.current[0] - dx * k, camera.current[1] - dy * k, camera.current[2]])

  // zoom scales the view's width by f, keeping the map point at stage px (px, py) in place.
  function zoom(px, py, f, instant = true) {
    const [x, y, z] = instant ? camera.current : camera.target
    const z2 = clamp(z + Math.log(f), ...ZOOM)
    const s = Math.exp(z2 - z)
    const mx = x + ((px - w / 2) * Math.exp(z)) / w
    const my = y + ((py - h / 2) * Math.exp(z)) / w
    look([mx + (x - mx) * s, my + (y - my) * s, z2], instant)
  }

  // Dragging pans, two fingers pinch, the wheel and double-click zoom,
  // and a quick drag keeps sliding for a moment after release.
  let el
  const pointers = new Map() // pointerId -> [x, y] in stage px
  let start // where the first pointer went down
  let dragged = false
  let velocity = [0, 0] // px per ms, of the last drag move
  let moved = 0 // timeStamp of the last drag move
  let fling = null
  let flight = null // a selection's trip, from fly(), advanced in step

  const pos = e => {
    const r = el.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  function down(e) {
    pointers.set(e.pointerId, pos(e))
    start = pos(e)
    dragged = false
    fling = null
  }

  function move(e) {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    if (!e.buttons) return pointers.delete(e.pointerId) // released outside the map
    const p = pos(e)
    if (!dragged) {
      if (Math.hypot(p[0] - start[0], p[1] - start[1]) < 4) return // still a click
      dragged = true
      el.setPointerCapture(e.pointerId)
    }
    const other = [...pointers].find(([id]) => id !== e.pointerId)?.[1]
    if (other) {
      const f = Math.hypot(prev[0] - other[0], prev[1] - other[1]) / Math.hypot(p[0] - other[0], p[1] - other[1])
      zoom((p[0] + other[0]) / 2, (p[1] + other[1]) / 2, f)
      pan((p[0] - prev[0]) / 2, (p[1] - prev[1]) / 2)
    } else {
      const dt = Math.max(1, e.timeStamp - moved)
      velocity = [(p[0] - prev[0]) / dt, (p[1] - prev[1]) / dt]
      moved = e.timeStamp
      pan(p[0] - prev[0], p[1] - prev[1])
    }
    pointers.set(e.pointerId, p)
  }

  function up(e) {
    pointers.delete(e.pointerId)
    if (dragged && !pointers.size && e.timeStamp - moved < 50 && Math.hypot(...velocity) > 0.2) fling = velocity
  }

  function wheel(e) {
    e.preventDefault()
    const [px, py] = pos(e)
    // Trackpad pinches arrive as ctrl+wheel with small deltas; Firefox counts wheel notches in lines.
    const d = e.deltaY * (e.deltaMode ? 40 : 1) * (e.ctrlKey ? 0.01 : 0.003)
    zoom(px, py, Math.exp(d), false)
  }

  // Svelte's onwheel is passive, and this one must stop the page from scrolling.
  $effect(() => {
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })

  // Animation state, advanced once per frame. The probe uncovers the route
  // as fast as hops arrive; every router it reaches sends a reply home.
  let now = $state(0)
  let reach = 0 // radians of route uncovered
  let arrived = {} // arrived[n]: time the probe reached hop n; by hop, as late host names split and merge stops
  let packets = [] // { pts, t0, dur, len, kind, n }: n is the hop at its far end, none for a flow
  let last // run the state above belongs to
  let lastFlow = 0
  let landed = false // the probe got to a destination that answered
  let refit = false // a new run started while the reader was zoomed in

  $effect(() => {
    let raf
    let prev = performance.now()
    const tick = t => {
      step(t, Math.min(0.05, (t - prev) / 1000))
      prev = now = t
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  })

  function step(t, dt) {
    if (run !== last) {
      ;[last, reach, arrived, packets, landed] = [run, 0, {}, [], false]
      refit = manual
    }
    // A reader zoomed in on the last route flies back once the new one has somewhere to go.
    if (refit && (run.target || run.status !== 'tracing')) {
      refit = false
      fit()
    }
    if (fling) {
      const [vx, vy] = fling
      pan(vx * dt * 1000, vy * dt * 1000)
      fling = Math.hypot(vx, vy) < 0.02 ? null : [vx * Math.exp(-dt * 6), vy * Math.exp(-dt * 6)]
    }
    if (flight) {
      // by frame time, which tick caps, so a long frame (a re-projected world) slows the trip instead of skipping it
      const u = (flight.u = clamp((flight.u ?? 0) + dt / 0.35))
      // sineInOut peaks at half cubicInOut's speed, so even a trip across the world is easy to follow
      const [x, y, vw] = flight.at(sineInOut(u) * flight.S)
      camera.set([x, y, Math.log(vw)], { instant: true })
      if (u === 1) {
        flight = null
        if (!manual) camera.set(frame) // the route may have grown on the way
      }
    }
    const total = stops.at(-1)?.d ?? 0
    // Hurry when behind. Once the probe is at a destination that answered, a late
    // host name that moves a stop redraws the route without sending the probe out again.
    reach = landed ? total : Math.min(total, reach + Math.max(1.2, (total - reach) * 6) * dt)
    landed = run.status === 'reached' && reach === total
    for (const [i, s] of stops.entries()) {
      if (s.d > reach) break
      if (i && !s.hops.some(n => arrived[n])) packets.push(packet(stops.slice(0, i + 1).reverse(), t, 'reply', s.hops[0]))
      for (const n of s.hops) arrived[n] ??= t
    }
    // Once the route is known, traffic keeps flowing along it; with a hop
    // selected, its own exchange repeats instead: a probe out, the reply back.
    if (run.status !== 'tracing' && reach === total && stops.length > 1 && t - lastFlow > 1000) {
      lastFlow = t
      const i = selected ? stops.findIndex(s => s.hops.includes(selected)) : -1
      if (i > 0) {
        const probe = packet(stops.slice(0, i + 1), t, 'probe', selected)
        packets.push(probe, packet(stops.slice(0, i + 1).reverse(), t + probe.dur, 'reply', selected))
      } else packets.push(packet(stops, t, 'flow'))
    }
    // A late host name can move a stop under a packet on its way.
    for (const p of packets) {
      const i = p.n ? stops.findIndex(s => s.hops.includes(p.n)) : stops.length - 1
      if (i >= 0) Object.assign(p, { pts: p.kind === 'reply' ? stops.slice(0, i + 1).reverse() : stops.slice(0, i + 1), len: stops[i].d })
    }
    packets = packets.filter(p => t < p.t0 + p.dur)
  }

  function packet(pts, t0, kind, n) {
    const len = pts.reduce((s, p, i) => (i ? s + geoDistance(ll(pts[i - 1]), ll(p)) : 0), 0)
    return { pts, t0, len, kind, n, dur: (kind === 'flow' ? 800 : 350) + len * (kind === 'flow' ? 500 : 400) }
  }

  // along returns the [lon, lat] a distance d (radians) along pts.
  function along(pts, d) {
    for (let i = 1; i < pts.length; i++) {
      const a = ll(pts[i - 1])
      const b = ll(pts[i])
      const seg = geoDistance(a, b)
      if (d <= seg || i === pts.length - 1) return geoInterpolate(a, b)(seg && Math.min(1, d / seg))
      d -= seg
    }
    return ll(pts[0])
  }

  let scene = $derived(draw(now))

  function draw(t) {
    const total = stops.at(-1)?.d ?? 0
    if (landed) reach = total // a late host name can move the end between steps
    const head = stops.length ? along(stops, reach) : null
    const line = [...stops.filter(s => s.d <= reach).map(ll), head]
    const shown = stops.flatMap((s, i) => {
      const age = t - Math.min(...s.hops.map(n => arrived[n] ?? t + 1)) // a stop shows once any of its hops arrived
      if (age < 0) return []
      const lit = s.hops.includes(hovered) || s.hops.includes(selected)
      return [{ ...s, i, at: xy(s), pop: backOut(clamp(age / 280)), ripple: age / 650, lit }]
    })
    const newest = shown.at(-1)
    const near = selected ? around(selected) : []
    const at = near.find(s => s.hops.includes(selected)) // none: the hop sits somewhere between near[0] and near[1]
    const i = near.indexOf(at)
    // the hop's own way in and out, which its stop's neighbours are only at the stop's edges
    const from = at ? at.hops[0] === selected && near[i - 1] : near[0]
    const to = at ? at.hops.at(-1) === selected && near[i + 1] : near[1]
    const link = (a, b, kind) => a && b && { kind, d: path({ type: 'LineString', coordinates: [ll(a), ll(b)] }), arrow: arrow(a, b, kind) }
    const role = s => (s === at ? 'lit' : s === from ? 'from' : s === to ? 'to' : '')
    return {
      route: stops.length ? path({ type: 'LineString', coordinates: line }) : null,
      // the selected hop's way in and way out
      links: (at ? [link(from, at, 'in'), link(at, to, 'out')] : [link(from, to, 'gap')]).filter(Boolean),
      head: head && (run.status === 'tracing' || reach < total) ? xy(head) : null,
      waiting: reach === total, // probe is at the newest hop, waiting for the next
      stops: shown.map(s => ({ ...s, role: selected ? role(stops[s.i]) || 'dim' : '' })),
      // Most important first: a label that would overlap an earlier one is dropped.
      labels: place([
        target && { id: 'target', at: xy(target), text: run.me ? `You · ${city(target) ?? target.ip}` : run.to, force: true },
        ...shown.filter(s => s.lit && s.i).map(s => ({ id: s.i, at: s.at, text: s.city, tag: tags(s.hops), force: true })),
        ...['from', 'to'].map(kind => {
          const s = shown.find(s => !s.lit && role(stops[s.i]) === kind)
          if (!s) return
          const hops = s.hops.filter(n => n && (kind === 'from' ? n < selected : n > selected))
          return { id: kind, kind, at: s.at, text: `${kind === 'from' ? 'from' : 'next'} · ${s.i ? s.city : 'the server'}`, tag: tags(hops), force: true }
        }),
        // away from where the route leaves, which a stop right beside the server doesn't show;
        // beside as seen in the fitted view, so the label keeps its side while the camera zooms
        shown[0]?.i === 0 &&
          role(stops[0]) !== 'from' && {
            id: 0,
            at: shown[0].at,
            away: shown.find(s => Math.hypot(s.at[0] - shown[0].at[0], s.at[1] - shown[0].at[1]) > (20 * Math.exp(frame[2])) / w)?.at,
            text: `Server · ${shown[0].city ?? '?'}`,
          },
        // the newest stop, until the probe gets to the destination, which has its own label
        !selected && (run.status !== 'reached' || reach < total) && newest?.i && !newest.lit && { id: newest.i, at: newest.at, away: shown.at(-2).at, text: newest.city },
      ]),
      packets: packets.filter(p => t >= p.t0).map(p => {
        const u = (t - p.t0) / p.dur
        // a reply from a stop that a late host name moved past the probe waits for it
        const at = u => xy(along(p.pts, Math.max(p.len * cubicInOut(clamp(u)), p.kind === 'reply' ? p.len - reach : 0)))
        return { kind: p.kind, fade: Math.min(1, u * 8, (1 - u) * 8), trail: [0, 1, 2, 3].map(j => at(u - j * 0.02)) }
      }),
    }
  }

  // place puts each label on the side of its point away from the route,
  // else the other side, else nowhere, keeping labels on screen and apart.
  function place(labels) {
    const boxes = []
    const width = text => [...text].reduce((w, c) => w + (c > '\u1100' && c !== '\u2013' ? 11.5 : 6.8), 0) // CJK is wide; tags' dash is not
    // Labels take their sides for the view the camera lands on, so they don't flip on the way.
    const [cx, , cz] = flight?.to ?? camera.target
    const [vx, vw] = [cx - Math.exp(cz) / 2, Math.exp(cz)]
    const k = vw / w
    return labels.filter(Boolean).flatMap(l => {
      const x = l.at[0] / k
      const y = l.at[1] / k
      const w = width(l.text + (l.tag ?? '')) + 6
      for (const side of l.away?.[0] > l.at[0] ? [-1, 1] : [1, -1]) {
        const x0 = side > 0 ? x + 10 : x - 10 - w
        if (x0 < vx / k || x0 + w > (vx + vw) / k) continue
        if (boxes.some(b => Math.abs(b.y - y) < 16 && b.x0 < x0 + w && x0 < b.x0 + b.w)) continue
        boxes.push({ x0, y, w })
        return [{ ...l, side }]
      }
      return l.force ? [{ ...l, side: x < (vx + vw) / k && x + 10 + w > (vx + vw) / k ? -1 : 1 }] : []
    })
  }

  // arrow points the way traffic went on the a→b link. It sits 40 px from the
  // selected hop, so it stays on screen when the far end doesn't, or midway on
  // a short link or a gap.
  function arrow(a, b, kind) {
    const along = geoInterpolate(ll(a), ll(b))
    // the link's length in px, measured where it leaves the selected hop:
    // a straight line between the ends is wrong when the link crosses the map's seam
    const [s, e] = kind === 'in' ? [0.999, 1] : [0, 0.001]
    const px = Math.hypot(xy(along(e))[0] - xy(along(s))[0], xy(along(e))[1] - xy(along(s))[1]) / k / 0.001
    const u = kind === 'gap' ? 0.5 : kind === 'in' ? Math.max(0.5, 1 - 40 / px) : Math.min(0.5, 40 / px)
    const [p, q] = [xy(along(u - 0.005)), xy(along(u + 0.005))]
    return { at: xy(along(u)), angle: (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI }
  }

  const pick = s => s.hops.find(n => n > 0) ?? null
  // tags writes hop numbers with each run of consecutive ones as a range: "#1–7", "#5 #7–8".
  const tags = ns => ns.reduce((t, n, i) => t + (ns[i - 1] === n - 1 ? (ns[i + 1] === n + 1 ? '' : `–${n}`) : ` #${n}`), '').trim()
</script>

<div class="map" bind:clientWidth={w} bind:clientHeight={h}>
  <svg
    bind:this={el}
    viewBox={view?.join(' ')}
    role="img"
    aria-label="Packet route map"
    class:focus={selected}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    ondblclick={e => flight || zoom(...pos(e), 0.5, false)}
  >
    {#if view && base}
      <g>
        <path class="sphere" d={base.sphere} />
        <path class="graticule" d={base.graticule} />
        <path class="land" d={base.land} />
        <path class="borders" d={base.borders} />
      </g>

      {#if target && stops.length}
        <path class="direct" d={path({ type: 'LineString', coordinates: [ll(stops[0]), ll(target)] })} />
      {/if}
      <path class="route casing" d={scene.route} />
      <path class="route" d={scene.route} />
      {#each scene.links as l (l.kind)}
        <path class="link {l.kind}" d={l.d} />
        <path class="arrow {l.kind}" d="M-4,-4.5 L2.5,0 L-4,4.5" transform="translate({l.arrow.at}) rotate({l.arrow.angle}) scale({k})" />
      {/each}

      {#each scene.stops as s (s.i)}
        {#if s.i && s.ripple < 1}
          <circle class="ripple" transform="translate({s.at}) scale({k})" r={5 + 26 * s.ripple} opacity={1 - s.ripple} />
        {/if}
      {/each}

      {#each scene.packets as p}
        <g class={p.kind} opacity={p.fade}>
          {#each p.trail as at, j}
            <circle transform="translate({at}) scale({k})" r={(j ? 2.2 : 2.8) - j * 0.45} opacity={1 - j * 0.28} />
          {/each}
        </g>
      {/each}

      {#if target}
        {#key target.lat}
          <g transform="translate({xy(target)}) scale({k})">
            <g class="target" class:reached={run.status === 'reached' || run.tcp}>
              {#if run.status === 'tracing'}
                <circle class="pulse" r="6" />
                <circle class="pulse late" r="6" />
              {/if}
              <circle r="5.5" />
            </g>
          </g>
        {/key}
      {/if}

      {#each scene.stops as s (s.i)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <g
          class="stop {s.role}"
          class:source={s.i === 0}
          class:lit={s.lit}
          transform="translate({s.at}) scale({k})"
          onpointerenter={e => e.pointerType === 'mouse' && (hovered = pick(s))}
          onpointerleave={() => (hovered = null)}
          onclick={() => dragged || (selected = selected === pick(s) ? null : pick(s))}
        >
          <circle class="hit" r="12" />
          <circle class="ring" r={(s.lit ? 10 : 0) * s.pop} />
          <circle class="dot" r={(s.i === 0 ? 5.5 : 4.2) * s.pop} />
          {#if s.i === 0}<circle class="core" r={1.6 * s.pop} />{/if}
        </g>
      {/each}

      {#each scene.labels as l (l.id)}
        <text
          class="label {l.kind}"
          class:target={l.id === 'target'}
          transform="translate({l.at}) scale({k})"
          x={11 * l.side}
          y="4"
          text-anchor={l.side > 0 ? 'start' : 'end'}
        >
          {l.text}{#if l.tag}<tspan dx="6">{l.tag}</tspan>{/if}
        </text>
      {/each}

      {#if scene.head}
        <g class="head" class:waiting={scene.waiting} transform="translate({scene.head}) scale({k})">
          <circle class="casing" r="5.5" />
          <circle class="pulse" r="5" />
          <circle r="3.4" />
        </g>
      {/if}
    {/if}
  </svg>

  <div class="controls">
    <button onclick={() => zoom(w / 2, h / 2, 0.5, false)} aria-label="Zoom in">+</button>
    <button onclick={() => zoom(w / 2, h / 2, 2, false)} aria-label="Zoom out">−</button>
    <button onclick={fit} disabled={!manual}>Fit route</button>
  </div>

  <ul class="legend">
    <li><i class="packet"></i>Probe out, replies back</li>
    <li><i class="direct"></i>Straight line</li>
  </ul>
</div>

<style>
  .map {
    position: absolute;
    inset: 0;
    background: var(--paper);
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  svg:active {
    cursor: grabbing;
  }

  path,
  circle {
    vector-effect: non-scaling-stroke;
  }

  .sphere {
    fill: none;
    stroke: #d8d6cf;
    stroke-width: 1;
  }

  .graticule {
    fill: none;
    stroke: #1616160a;
    stroke-width: 0.6;
  }

  /* White land on paper needs its coast drawn once you zoom in. */
  .land {
    fill: var(--sheet);
    stroke: #d3d1ca;
    stroke-width: 0.6;
  }

  .borders {
    fill: none;
    stroke: #dcdad3;
    stroke-width: 0.6;
  }

  .direct {
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.4;
    stroke-dasharray: 0 5;
    stroke-linecap: round;
    animation: fade 0.15s both;
  }

  .route {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Not a glow: a casing that parts the route from the borders under it. */
  .route.casing {
    stroke: var(--sheet);
    stroke-width: 5;
  }

  /* A selected hop keeps its way in (ink) and way out (accent); the rest steps back. */
  .focus :is(.route, .direct, .flow, .ripple, .stop.dim) {
    opacity: 0.2;
    transition: opacity 0.15s;
  }

  .link,
  .arrow {
    fill: none;
    stroke: var(--ink);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .link.out,
  .arrow.out {
    stroke: var(--accent);
  }

  .link.gap {
    stroke: var(--ink-3);
    stroke-dasharray: 3 5;
  }

  .arrow.gap {
    stroke: var(--ink-3);
  }

  .ripple {
    fill: none;
    stroke: var(--accent); /* the router answers in the packet color */
    stroke-width: 1.2;
  }

  .reply circle,
  .flow circle,
  .probe circle {
    fill: var(--accent);
  }

  .stop {
    cursor: pointer;
  }

  .hit {
    fill: transparent;
  }

  .stop .dot {
    fill: var(--sheet);
    stroke: var(--ink);
    stroke-width: 1.5;
  }

  .stop.lit .dot,
  .stop.source .dot {
    fill: var(--ink);
  }

  .stop.to .dot {
    stroke: var(--accent);
    stroke-width: 2;
  }

  .stop.source .core {
    fill: var(--sheet);
  }

  .stop .ring {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1;
    transition: r 0.12s ease-out;
  }

  .label {
    fill: var(--ink);
    font-size: 12px;
    font-weight: 600;
    paint-order: stroke;
    stroke: var(--sheet);
    stroke-width: 4px;
    stroke-linejoin: round;
    pointer-events: none;
    animation: fade 0.12s both;
  }

  .label tspan {
    fill: var(--ink-2);
    font: 500 10.5px var(--mono);
  }

  .label.target {
    font-weight: 700;
  }

  .label.to {
    fill: var(--accent);
  }

  .pulse {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    transform-box: fill-box;
    transform-origin: center;
    animation: pulse 2.2s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
  }

  .pulse.late {
    animation-delay: 1.1s;
  }

  .target {
    color: var(--ink);
    animation: drop 0.15s ease-out both;
  }

  .target > circle:not(.pulse) {
    fill: var(--sheet);
    stroke: var(--ink);
    stroke-width: 2.5;
  }

  .target.reached > circle:not(.pulse) {
    fill: var(--ink);
  }

  .head {
    color: var(--accent);
    pointer-events: none;
  }

  .head > circle {
    fill: var(--accent);
  }

  /* a paper ring that lifts the probe off the route line */
  .head .casing {
    fill: var(--sheet);
  }

  .head .pulse {
    display: none;
  }

  .head.waiting .pulse {
    display: inline;
    fill: none;
    animation-duration: 1.2s;
  }

  .legend {
    position: absolute;
    left: 20px;
    bottom: 16px;
    display: flex;
    gap: 18px;
    list-style: none;
    color: var(--ink-2);
    font-size: 12px;
    pointer-events: none;
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .legend .packet {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  .legend .direct {
    width: 18px;
    border-top: 2px dotted var(--ink-3);
  }

  .controls {
    position: absolute;
    right: 16px;
    bottom: 12px;
    display: flex;
    gap: 4px;
  }

  .controls button {
    min-width: 30px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--ink);
    background: var(--sheet);
    color: var(--ink);
    font-size: 13px;
  }

  .controls button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes pulse {
    from {
      transform: scale(1);
      opacity: 0.6;
    }
    to {
      transform: scale(3.4);
      opacity: 0;
    }
  }

  @keyframes drop {
    from {
      opacity: 0;
      translate: 0 -6px;
    }
  }

  @media (max-width: 900px) {
    .legend {
      left: 16px;
      bottom: 12px;
    }

    /* the legend has the bottom edge on phones and narrow windows */
    .controls {
      top: 12px;
      bottom: auto;
    }
  }
</style>
