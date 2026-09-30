<script>
  import WorldMap from './WorldMap.svelte'
  import Hops from './Hops.svelte'
  import { locate, place, route } from './lib.js'

  let source = $state(null) // the server, where every trace starts
  let run = $state({})
  let selected = $state(null) // hop number
  let hovered = $state(null)
  let input = $state(new URLSearchParams(location.search).get('to') ?? '')
  let es

  let spots = $derived(locate(source, run.hops, run.names)) // each hop's place, or null
  let stops = $derived(route(source, spots))
  // Once the destination answers probes, its own place replaces the DB's guess;
  // when there is none (anycast), pin it where the route got to. An answer on
  // port 443 alone still checks the DB's place against that round trip. An
  // anycast address has no one place until something answers.
  let target = $derived.by(() => {
    const t = run.target
    if (t?.lat == null) return null
    const answered = run.hops.at(-1)?.replies.some(r => r.ip === t.ip)
    const p = answered
      ? (spots.at(-1) ?? stops.at(-1))
      : run.tcp
        ? place({ ...t, ms: [run.tcp.ms] }, run.names[t.ip], source, stops.at(-1))
        : t.anycast
          ? null
          : t
    return p && { ...t, lat: p.lat, lon: p.lon, city: p.city }
  })

  // Accepts pasted URLs: "https://naver.com:443/x" traces naver.com.
  function start(to = input.trim().replace(/^\w+:\/\/|[/?#].*$/g, '').replace(/^([^:]*):\d+$/, '$1')) {
    es?.close()
    input = to
    selected = hovered = null
    run = { to, me: !to, target: null, hops: [], names: {}, tcp: null, status: 'tracing', error: null }
    const q = to ? '?to=' + encodeURIComponent(to) : ''
    history.replaceState(null, '', q || location.pathname)

    es = new EventSource('/api/trace' + q)
    const on = (type, fn) => es.addEventListener(type, e => fn(JSON.parse(e.data)))
    on('start', d => {
      source = d.source ?? source
      run.me = d.me
    })
    on('target', d => (run.target = d))
    on('hop', h => {
      run.hops[h.n - 1] = h
      // Delivered now: 'end' waits for the last names and the port 443 check.
      if (h.replies.some(r => r.ip === run.target?.ip)) run.status = 'reached'
    })
    on('name', d => (run.names[d.ip] = d))
    on('tcp', d => (run.tcp = d))
    on('end', d => {
      es.close()
      run.error = d.error
      run.status = d.error ? 'error' : d.reached ? 'reached' : 'stopped'
    })
    es.onerror = () => {
      es.close()
      run.status = 'error'
      run.error = 'Lost the connection to the server.'
    }
  }

  start()
</script>

<main>
  <section class="stage">
    <WorldMap {source} {target} {stops} {run} bind:selected bind:hovered />
  </section>

  <aside>
    <form
      onsubmit={e => {
        e.preventDefault()
        if (matchMedia('(pointer: coarse)').matches) document.activeElement.blur() // puts a phone's keyboard away
        start()
      }}
    >
      <input bind:value={input} placeholder="Host or IP · empty for you" aria-label="Host or IP address" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" />
      <button>Trace</button>
    </form>

    <Hops {source} {run} {spots} {stops} {target} bind:selected bind:hovered />
  </aside>
</main>

<style>
  main {
    display: grid;
    grid-template-columns: 1fr 460px;
    height: 100%;
  }

  .stage {
    position: relative;
    overflow: hidden;
    min-height: 0;
  }

  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--rule);
  }

  form {
    display: flex;
    height: 36px;
    margin: 14px var(--gutter) 0;
    border: 1px solid var(--ink);
  }

  form:focus-within {
    outline: 2px solid var(--ink);
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 0 10px;
    outline: none;
    font: 13.5px var(--mono);
    font-variant-ligatures: none; /* Chivo Mono would join ff, fl and ffi in hosts and ::ffff: */
  }

  input::placeholder {
    color: var(--ink-3);
    font-family: var(--sans);
  }

  form button {
    padding: 0 16px;
    background: var(--ink);
    color: var(--sheet);
    font-weight: 600;
  }

  form button:active {
    background: var(--ink-2);
  }

  @media (max-width: 860px) {
    main {
      display: block;
      height: auto;
    }

    /* The map stays in view, so a hop tapped in the list shows on it. */
    .stage {
      position: sticky;
      top: 0;
      z-index: 2;
      height: var(--map-h);
      border-bottom: 1px solid var(--rule);
    }

    aside {
      display: block;
      border-left: 0;
    }

    /* iOS zooms into a field whose text is under 16px */
    input {
      font-size: 16px;
    }
  }
</style>
