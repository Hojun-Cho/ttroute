<script>
  import { city, fmt, km, num, place, tooFar } from './lib.js'

  // One hop as the exchange it was: who answered the probes sent with this
  // TTL, with what, and what is known about them. `last` is past `hop.n` for
  // a folded run of silent hops.
  let { hop, last, spot, via, before, after, source, run } = $props()

  const lost = $derived(hop.sent - hop.replies.reduce((s, r) => s + r.ms.length, 0))
  const label = x => `hop ${x.hop.n} · ${x.at ? x.at.city : x.r.ip}`
</script>

{#if !hop.replies.length}
  <dl>
    <dt>Reply</dt>
    <dd>none<small>{(last - hop.n + 1) * hop.sent} probes lost</small></dd>
  </dl>
  <p>{after ? 'Silent routers pass traffic on without answering probes.' : 'Nothing answered from here on; the probes may be filtered.'}</p>
{:else if hop.replies.length > 1}
  <p>{hop.replies.length} routers answered: the network spreads probes over parallel links.</p>
{/if}

{#each hop.replies as r (r.ip)}
  {@const name = run.names[r.ip]}
  {@const p = place(r, name, source, via) ?? (spot?.near ? spot : null)}
  {@const min = Math.min(...r.ms)}
  <dl>
    <dt>Reply</dt>
    <dd>{r.tcp ? 'Handshake on port 443' : r.ip === run.target?.ip ? 'Echo reply' : 'Time exceeded'}<small class="mono">{r.ms.map(fmt).join(' ')} ms</small></dd>
    <dt>IP</dt>
    <dd><span class="mono">{r.ip}</span><small>{r.kind}</small></dd>
    {#if r.net}
      <dt>Block</dt>
      <dd><span class="mono">{r.net}</span><small class="mono">{r.mask}</small></dd>
    {/if}
    {#if r.asn}
      <dt>Network</dt>
      <dd>{r.org}<small>AS{r.asn}</small></dd>
    {/if}
    {#if name?.host}
      <dt>Host</dt>
      <dd class="mono">{name.host}</dd>
    {/if}
    {#if name?.device}
      <dt>Device</dt>
      <dd>{name.device}</dd>
    {/if}
    {#if p?.near}
      <dt>Place</dt>
      <dd>near {p.city}, {p.cc}<small>{fmt(p.lag)} ms after {p.n ? `hop ${p.n}` : 'the server'}</small></dd>
    {:else if p}
      <dt>Place</dt>
      <dd>
        {p.city}, {p.cc}<small>{p.from}{source?.lat != null ? ` · ${num(km(source, p))} km away` : ''}</small>
      </dd>
    {/if}
    <!-- The destination's database city shows even where only the time since via ruled it out. It is
         struck only where the round trip alone does: anything through via rests on via's place. -->
    {#if tooFar(r, source, via) || (r.dest && r.lat != null && (!p || p.near))}
      {@const far = tooFar(r, source, source)}
      <dt>Database</dt>
      <dd>
        <span class="db" class:far>{city(r) ?? r.country}, {r.cc}</span><small>{far ? `too far for ${fmt(min)} ms` : `too far from ${via.city}`}</small>
      </dd>
    {/if}
  </dl>
{/each}

{#if lost && hop.replies.length}
  <p>{lost} of {hop.sent} probes got no reply.</p>
{/if}

{#if before || after}
  <dl>
    {#if before}<dt>From</dt><dd class="from">{label(before)}</dd>{/if}
    {#if after}<dt>Next</dt><dd class="to">{label(after)}</dd>{/if}
  </dl>
{/if}

<style>
  dl,
  p {
    padding: 8px 0;
    border-top: 1px solid var(--rule);
  }

  dl {
    display: grid;
    grid-template-columns: var(--label) minmax(0, 1fr);
    gap: 2px var(--gap);
  }

  dt {
    text-align: right;
    color: var(--ink-3);
  }

  /* A note that doesn't fit beside its value goes under it, instead of squeezing it mid-word. */
  dd {
    display: flex;
    flex-wrap: wrap;
    gap: 0 12px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  small {
    margin-left: auto;
    color: var(--ink-3);
    font-size: inherit;
    text-align: right;
  }

  p {
    padding-left: calc(var(--label) + var(--gap));
    color: var(--ink-2);
  }

  .db {
    color: var(--ink-2);
  }

  .far {
    text-decoration: line-through;
  }

  .mono {
    font: 12.5px var(--mono);
    font-variant-ligatures: none; /* Chivo Mono would join ff, fl and ffi in hosts and ::ffff: */
  }

  .from {
    font-weight: 600;
  }

  .to {
    color: var(--accent);
    font-weight: 600;
  }
</style>
