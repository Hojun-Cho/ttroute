<script>
  import { untrack } from 'svelte'
  import { slide } from 'svelte/transition'
  import HopDetail from './HopDetail.svelte'
  import { city, fmt, km, num, rtt, tooFar } from './lib.js'

  let { source, run, spots, stops, target, selected = $bindable(), hovered = $bindable() } = $props()

  const JUMP = 20 // ms; a bigger step between hops usually means a long cable
  const HEADLINE = { tracing: 'In transit', reached: 'Delivered', stopped: 'No answer at the door', error: 'Trace failed' }

  let hops = $derived(run.hops)
  // One row per hop, except that a run of silent hops folds into one row.
  let rows = $derived.by(() => {
    const out = []
    let prev = null // last row that answered
    let org // last network seen
    let via = source // last hop placed, which later probes passed
    for (const hop of hops) {
      const r = hop.replies[0]
      if (!r) {
        if (out.at(-1)?.silent) out.at(-1).last = hop.n
        else out.push({ hop, silent: true, last: hop.n })
        continue
      }
      const ms = rtt(hop)
      const row = { hop, r, ms, via, at: spots[hop.n - 1], entered: r.org && r.org !== org }
      if (prev && ms - prev.ms > JUMP) row.jump = `+${fmt(ms - prev.ms)} ms since hop ${prev.hop.n}`
      out.push((prev = row))
      if (r.org) org = r.org
      if (row.at && !row.at.near) via = row.at
    }
    return out
  })
  let answered = $derived(rows.filter(x => x.r))
  let last = $derived(answered.at(-1))
  let seen = $derived(answered.findLast(x => x.at)) // the last hop placed, like a parcel's last scan
  let nets = $derived(answered.filter(x => x.entered))
  let routeKm = $derived((stops.at(-1)?.d ?? 0) * 6371)
  let directKm = $derived(stops.length > 1 ? km(stops[0], stops.at(-1)) : 0)
  let open = $derived(rows.findIndex(x => x.hop.n === selected))
  let before = $derived(open > 0 ? rows.slice(0, open).findLast(x => x.r) : null)
  let after = $derived(open >= 0 ? rows.slice(open + 1).find(x => x.r) : null)

  // The probes stopped short, but the destination answered on port 443.
  let knocked = $derived(run.status === 'stopped' && run.tcp)

  // One line on a phone: the headline, the summary and the rows say the rest.
  let note = $derived.by(() => {
    if (run.status === 'tracing') return seen ? `Last seen in ${seen.at.city}.` : `Probing hop ${hops.length + 1}.`
    if (run.status === 'reached') return `${run.me ? 'You' : 'The destination'} answered at hop ${hops.length}.`
    if (knocked) return 'Answered on port 443, not to probes.'
    if (run.status === 'stopped') return seen ? `Last seen at hop ${seen.hop.n} in ${seen.at.city}.` : ''
    return run.error
  })

  const KINDS = { public: 'Unknown place', private: 'Private network', 'carrier-grade NAT': 'Carrier NAT', loopback: 'This machine', 'link-local': 'Local link' }
  const where = x =>
    x.r.kind !== 'public' || !x.at ? KINDS[x.r.kind] : `${x.at.near ? 'near ' : ''}${x.at.city}, ${x.at.cc}`
  // A second line only when it says something new.
  const sub = x =>
    [
      x.entered && x.r.org,
      x.r.ip === run.target?.ip && (run.me ? 'you' : 'destination'),
      x.r.anycast && `anycast, ${x.r.anycast.length} sites`,
      (!x.at || x.at.near) && tooFar(x.r, source, x.via) && `not ${city(x.r)}: too fast`,
      x.jump,
    ]
      .filter(Boolean)
      .join(' · ')
  const toggle = n => (selected = selected === n ? null : n)

  // Keep the live row in view while tracing, unless the reader is on a hop.
  // Desktop only: on phones the page itself scrolls.
  $effect(() => {
    if (hops.length && innerWidth > 860 && untrack(() => selected == null && hovered == null))
      document.querySelector('.hops > li:last-child')?.scrollIntoView({ block: 'nearest' })
  })
</script>

<section class="summary">
  <p class="subject">
    <span class="k">Tracking</span>
    <span><b>{run.me ? 'You' : run.to}</b>{#if run.target?.ip !== run.to}<code>{run.target?.ip}</code>{/if}</span>
  </p>
  <h1 class={run.status} aria-live="polite">{HEADLINE[knocked ? 'reached' : run.status]}</h1>
  <p class="note">{note}</p>

  {#if hops.length}
    <dl>
      <dt>From</dt>
      <dd>{source ? `Server in ${[city(source), source.country].filter(Boolean).join(', ')}` : '—'}</dd>
      <dt>Hops</dt>
      <dd>
        {hops.length}
        {#if answered.length < hops.length}<small>{hops.length - answered.length} silent</small>{/if}
      </dd>
      <dt>Round trip</dt>
      <dd>
        {#if knocked}
          {fmt(run.tcp.ms)} ms<small>port 443</small>
        {:else}
          {last ? `${fmt(last.ms)} ms` : '—'}
          {#if last && run.status !== 'reached'}<small>to hop {last.hop.n}</small>{/if}
        {/if}
      </dd>
      <dt>Distance</dt>
      <dd>
        {#if knocked && target && source?.lat != null}
          {num(km(source, target))} km<small>straight line; the route is hidden</small>
        {:else}
          {#if routeKm < 50}all near {stops[0]?.city ?? 'the server'}{:else}{num(routeKm)} km{/if}
          {#if directKm > 50}<small>{(routeKm / directKm).toFixed(1)} × the straight line</small>{/if}
        {/if}
      </dd>
      <dt>Networks</dt>
      {#each nets as x (x.hop.n)}
        <dd>{x.r.org}<small>from hop {x.hop.n}</small></dd>
      {:else}
        <dd>—</dd>
      {/each}
    </dl>
  {/if}
</section>

<div class="scroll">
  {#if hops.length}
    <p class="thead"><span>Hop</span><span>Router</span><span>ms</span></p>
  {/if}
  <ol class="hops">
    {#each rows as x (x.hop.n)}
      <li
        class:silent={x.silent}
        class:entered={x.entered}
        class:lit={hovered === x.hop.n}
        class:open={selected === x.hop.n}
        class:from={before === x}
        class:to={after === x}
      >
        <button
          id="hop-{x.hop.n}"
          class="row"
          onclick={() => toggle(x.hop.n)}
          onpointerenter={e => e.pointerType === 'mouse' && (hovered = x.hop.n)}
          onpointerleave={() => (hovered = null)}
        >
          <span class="n">{x.hop.n}{x.silent && x.last > x.hop.n ? `–${x.last}` : ''}</span>
          {#if x.silent}
            <span class="where">No reply</span>
            <span class="ms">* * *</span>
          {:else}
            <span class="where" class:unsure={!x.at || x.at.near}>{where(x)}</span>
            <span class="ms">{fmt(x.ms)}</span>
            {#if sub(x)}<span class="sub">{sub(x)}</span>{/if}
          {/if}
        </button>

        {#if selected === x.hop.n}
          <!-- once open, the whole hop scrolls into view, wherever it was selected -->
          <div class="detail" transition:slide={{ duration: 120 }} onintroend={e => e.currentTarget.parentElement.scrollIntoView({ block: 'nearest' })}>
            <HopDetail hop={x.hop} last={x.last} spot={x.at} via={x.via} {before} {after} {source} {run} />
          </div>
        {/if}
      </li>
    {/each}

    {#if knocked}
      <li class="knock">
        <div class="row">
          <span class="n">443</span>
          <span class="where">{target ? `${target.city}, ${target.cc}` : run.target?.ip}</span>
          <span class="ms">{fmt(run.tcp.ms)}</span>
          <span class="sub">{run.me ? 'you' : 'destination'} · answered on port 443, not to probes</span>
        </div>
      </li>
    {/if}

    {#if run.status === 'tracing'}
      <li class="live">
        <div class="row">
          <span class="n">{hops.length + 1}</span>
          <span class="where">Waiting for a reply</span>
        </div>
      </li>
    {/if}
  </ol>

  <footer>
    <p>Each probe goes one router further than the last; the replies, in order, are the route.</p>
    <p>
      Places come from router host names, the <a href="https://manycast.net" target="_blank" rel="noreferrer">LACeS</a> anycast
      census, <a href="https://ipmap.ripe.net" target="_blank" rel="noreferrer">RIPE IPmap</a> and
      <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>.
    </p>
  </footer>
</div>

<style>
  .summary {
    padding: 16px var(--gutter) 18px;
    border-bottom: 1px solid var(--rule);
  }

  .subject,
  dl,
  .thead,
  .row {
    display: grid;
    grid-template-columns: var(--label) minmax(0, 1fr) auto;
    column-gap: var(--gap);
  }

  .k,
  dt,
  .thead span:first-child,
  .n {
    grid-column: 1;
    text-align: right;
    color: var(--ink-3);
  }

  .subject {
    align-items: baseline;
  }

  .subject > span:last-child {
    grid-column: 2 / -1;
    overflow-wrap: anywhere;
  }

  .subject b {
    font: 500 15px var(--mono);
    font-variant-ligatures: none; /* Chivo Mono would join ff, fl and ffi in hosts and ::ffff: */
  }

  .subject code {
    margin-left: 10px;
    color: var(--ink-3);
    font: 13px var(--mono);
    font-variant-ligatures: none;
  }

  h1,
  .note {
    margin-left: calc(var(--label) + var(--gap));
  }

  h1 {
    margin-top: 4px;
    font-size: 34px;
    font-weight: 700;
    font-stretch: 75%;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }

  h1.tracing {
    color: var(--accent);
  }

  /* one line even for a long city, so the list below never shifts */
  .note {
    margin-top: 6px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .summary dl {
    margin-top: 16px;
    row-gap: 2px;
    font-size: 13px;
  }

  dd {
    grid-column: 2 / -1;
    min-width: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  dd small {
    color: var(--ink-2);
    font-size: inherit;
    white-space: nowrap;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scroll-padding-top: 34px; /* rows scrolled to stay clear of the sticky header */
  }

  .thead {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 10px var(--gutter) 5px;
    border-bottom: 1px solid var(--rule);
    background: var(--sheet);
    color: var(--ink-3);
    font-size: 12px;
  }

  .thead span:last-child {
    text-align: right;
  }

  .hops {
    list-style: none;
  }

  /* a rule where the packet changes hands, matching "Networks" above */
  li.entered::before,
  li.knock::before {
    content: '';
    display: block;
    margin-left: calc(var(--gutter) + var(--label) + var(--gap));
    border-top: 1px solid var(--rule);
  }

  li.lit,
  li.open {
    background: var(--paper);
  }

  .row {
    width: 100%;
    padding: 6px var(--gutter);
    align-items: baseline;
    text-align: left;
    line-height: 1.35;
    outline-offset: -2px; /* the scroll box would clip a ring drawn outside */
  }

  .n {
    font: 12px var(--mono);
  }

  li.lit .n,
  li.open .n,
  li.from .n {
    color: var(--ink);
  }

  /* where the selected hop leads, in the color the map uses for it */
  li.to .n {
    color: var(--accent);
  }

  .where,
  .sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .where {
    font-weight: 500;
  }

  .where.unsure {
    color: var(--ink-2);
  }

  .ms {
    font: 500 13.5px var(--mono);
    text-align: right;
  }

  .sub {
    grid-column: 2 / -1;
    color: var(--ink-2);
    font-size: 12.5px;
  }

  li.silent .where,
  li.silent .ms {
    color: var(--ink-3);
    font-weight: 400;
  }

  li.live .n,
  li.live .where {
    color: var(--accent);
  }

  .detail {
    padding: 2px var(--gutter) 14px;
    font-size: 13px;
  }

  footer {
    display: grid;
    gap: 6px;
    padding: 18px var(--gutter) 28px calc(var(--gutter) + var(--label) + var(--gap));
    color: var(--ink-3);
    font-size: 12px;
  }

  footer a {
    color: inherit;
  }

  @media (max-width: 860px) {
    .scroll {
      overflow: visible;
    }

    .thead {
      top: var(--map-h);
    }

    .row,
    li {
      scroll-margin-top: calc(var(--map-h) + 34px);
    }
  }
</style>
