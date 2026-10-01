// The world's paths for a map center, drawn off the main thread: on a phone a new center is most of a second of script.
import { geoNaturalEarth1, geoPath, geoGraticule10, geoStream } from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import world from 'world-atlas/countries-50m.json'

const sphere = { type: 'Sphere' }
const land = feature(world, world.objects.land)
const borders = mesh(world, world.objects.countries, (a, b) => a !== b)
const graticule = geoGraticule10()
const W = 1000 // projected width of the world, in map units, as WorldMap has it
const CELL = 100 // map units: the land comes in pieces by cell, so that drawing a view skips those off screen

onmessage = ({ data: lon }) => {
  const projection = geoNaturalEarth1().rotate([-lon, 0]).fitWidth(W, sphere)
  const path = geoPath(projection)
  postMessage({ lon, sphere: path(sphere), graticule: path(graticule), ...pieces(projection) })
}

// pieces returns the land, its coast and the borders as paths, one per cell of the map
// they fall in. The land fills by whole parts, as the map's edge cuts it, each with the
// holes it holds (the Caspian); the coast and borders are cut where they cross cells.
function pieces(projection) {
  const polygons = project(land, projection)
  const fill = {}
  for (const rings of polygons) {
    const holes = rings.filter(r => area(r) < 0)
    for (const r of rings.filter(r => area(r) > 0)) put(fill, r[0], [r, ...holes.filter(h => inside(h[0], r))].map(r => svg(r, 'Z')).join(''))
  }
  return { land: joined(fill), coast: cut(polygons.flat(), true), borders: cut(project(borders, projection).flat()) }
}

// project returns the object's projected lines, as one group, then each polygon's rings.
function project(object, projection) {
  const groups = [[]]
  geoStream(object, projection.stream({ polygonStart: () => groups.push([]), polygonEnd() {}, lineStart: () => groups.at(-1).push([]), lineEnd() {}, point: (x, y) => groups.at(-1).at(-1).push([x, y]) }))
  return groups
}

// cut splits lines where they pass into another cell; a ring that stays in its cell stays closed.
function cut(lines, closed) {
  const cells = {}
  for (const line of lines) {
    const pts = closed ? [...line, line[0]] : line
    let piece = [pts[0]]
    for (const p of pts.slice(1)) {
      piece.push(p)
      if (cell(p) !== cell(piece[0])) put(cells, piece[0], svg(piece)), (piece = [p])
    }
    if (closed && piece.length === pts.length) put(cells, line[0], svg(line, 'Z'))
    else if (piece.length > 1) put(cells, piece[0], svg(piece))
  }
  return joined(cells)
}

const cell = ([x, y]) => Math.floor(x / CELL) * 100 + Math.floor(y / CELL)
const put = (cells, p, d) => (cells[cell(p)] ??= []).push(d)
const joined = cells => Object.values(cells).map(ds => ds.join(''))
const area = r => r.reduce((a, [x, y], i) => a + x * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * y, 0) // < 0 for a hole
const inside = ([x, y], r) => r.reduce((odd, [x0, y0], i) => { const [x1, y1] = r[(i + 1) % r.length]; return (y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0) ? !odd : odd }, false)
// as d3's geoPath writes it, to 3 decimals
const svg = (pts, end = '') => 'M' + pts.map(([x, y]) => `${Math.round(x * 1e3) / 1e3},${Math.round(y * 1e3) / 1e3}`).join('L') + end
