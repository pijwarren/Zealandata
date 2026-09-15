/*
 * One-off generator for projector/coastline_uv.h -- pulls Natural Earth's
 * 10m-resolution land polygon data (the finest they publish; earth
 * .nullschool.net's own bundled coastline_50m.json, the original source
 * for coastline_uv.h, tops out at 50m and visibly flattens the harbours/
 * inlets around Cook Strait at this model's scale), clips it down to the
 * AOI around CENTER_LON/CENTER_LAT, and reprojects every remaining vertex
 * through geo_grid.mjs's own lonLatToUV -- the exact inverse of the
 * transform fetch_wind.mjs/fetch_waves.mjs/fetch_currents.mjs use to turn
 * grid cells into lon/lat -- so the regenerated header lines up with the
 * live wind/waves/currents particles without a separate calibration pass.
 *
 * Not run automatically by anything; re-run by hand (`node
 * weather/gen_coastline.mjs`) only when swapping coastline fidelity or
 * if CENTER_LON/CENTER_LAT/HALF_WIDTH_KM/HALF_HEIGHT_KM/MODEL_ROTATION_DEG
 * in geo_grid.mjs ever change (see weather/README.md's "Geographic
 * alignment" section -- those are hand-confirmed against the physical
 * print, not something this script re-derives).
 */

import { writeFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  CENTER_LON, CENTER_LAT, HALF_WIDTH_KM, HALF_HEIGHT_KM, lonLatToUV,
} from './geo_grid.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Natural Earth's own GitHub mirror -- the canonical naturalearthdata.com
// downloads are versioned zip/shapefiles with no stable direct-download
// URL; this repo re-publishes each vintage as plain GeoJSON, is what most
// tooling links to, and needs no unzip/shapefile parsing step.
const NE_10M_LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson'
// Cached alongside vendor/earth (see weather/README.md) but gitignored --
// ~10MB of upstream data, no reason to carry it in version control when
// only the small reprojected/clipped output (coastline_uv.h) is needed.
const CACHE_PATH = path.join(__dirname, 'vendor', 'natural_earth', 'ne_10m_land.geojson')
const OUTPUT_PATH = path.join(__dirname, '..', 'projector', 'coastline_uv.h')

// Generous margin around the AOI before any rotation is applied -- the
// model is rotated 120deg, so its footprint's lon/lat bounding box can
// extend up to sqrt(HALF_WIDTH_KM^2 + HALF_HEIGHT_KM^2) from center along
// the worst-case diagonal (~1139km here, ~10.2deg of lat); rounded up
// well past that so no real AOI edge gets clipped by this pre-filter.
const KM_PER_DEG_LAT = 111.32
const MARGIN_DEG = Math.ceil(Math.sqrt(HALF_WIDTH_KM ** 2 + HALF_HEIGHT_KM ** 2) / KM_PER_DEG_LAT) + 2
const LON_MIN = CENTER_LON - MARGIN_DEG, LON_MAX = CENTER_LON + MARGIN_DEG
const LAT_MIN = CENTER_LAT - MARGIN_DEG, LAT_MAX = CENTER_LAT + MARGIN_DEG

// Slightly past [0,1] so segments that cross the model's edge still
// contribute their part of the line/mask right up to the boundary,
// instead of popping off one endpoint early.
const UV_MARGIN = 0.1

async function loadLandGeoJSON() {
  if (existsSync(CACHE_PATH)) {
    console.log(`[gen_coastline] using cached ${CACHE_PATH}`)
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'))
  }
  console.log(`[gen_coastline] fetching ${NE_10M_LAND_URL}`)
  const res = await fetch(NE_10M_LAND_URL)
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`)
  const text = await res.text()
  await mkdir(path.dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, text)
  console.log(`[gen_coastline] cached to ${CACHE_PATH}`)
  return JSON.parse(text)
}

// Natural Earth land polygons never cross the antimeridian near NZ (this
// AOI sits at lon ~172E, nowhere near +-180), so no antimeridian-wrapping
// logic is needed here -- a plain bbox test is enough.
function ringNearAOI(ring) {
  for (const [lon, lat] of ring) {
    if (lon >= LON_MIN && lon <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX) return true
  }
  return false
}

function collectRings(geojson) {
  const rings = []
  for (const feature of geojson.features) {
    const geom = feature.geometry
    if (!geom) continue
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
      : geom.type === 'MultiPolygon' ? geom.coordinates
      : []
    for (const poly of polys) {
      for (const ring of poly) {
        if (ringNearAOI(ring)) rings.push(ring)
      }
    }
  }
  return rings
}

function uvInRange(u, v) {
  return u >= -UV_MARGIN && u <= 1 + UV_MARGIN && v >= -UV_MARGIN && v <= 1 + UV_MARGIN
}

// Each closed ring -> one GL_LINES segment per edge (including the
// closing edge back to the first vertex), matching the flat
// "x0,y0, x1,y1, x1,y1, x2,y2, ..." layout projector.c's
// glDrawArrays(GL_LINES, ...) expects (see coastline_uv.h) -- a segment
// is kept if either endpoint lands within UV_MARGIN of the model's
// [0,1]^2 footprint.
function ringToUVSegments(ring) {
  const uvs = ring.map(([lon, lat]) => lonLatToUV(lon, lat))
  const segments = []
  for (let i = 0; i < uvs.length; i++) {
    const [u0, v0] = uvs[i]
    const [u1, v1] = uvs[(i + 1) % uvs.length]
    if (uvInRange(u0, v0) || uvInRange(u1, v1)) segments.push(u0, v0, u1, v1)
  }
  return segments
}

function formatHeader(verts) {
  const numVerts = verts.length / 2
  const floats = verts.map((v) => `${v.toFixed(5)}f`)
  // 4 vertices (2 segments) per line, matching the original file's width.
  const lines = []
  for (let i = 0; i < floats.length; i += 8) {
    lines.push('    ' + floats.slice(i, i + 8).join(',') + ',')
  }
  // Drop the trailing comma on the very last value.
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')

  return `/* Generated from Natural Earth's 10m land polygons (see weather/gen_coastline.mjs), transformed through geo_grid.mjs's lonLatToUV (CENTER_LON/LAT, HALF_WIDTH/HEIGHT_KM, MODEL_ROTATION_DEG). Drawn as a white line overlay on the wind/waves/currents composite and rasterised into a land mask that keeps particles off land -- see build_land_mask() and WIND_COASTLINE_VS_SRC in projector.c. Regenerate with \`node weather/gen_coastline.mjs\` if those geo_grid.mjs constants ever change. */
#define COASTLINE_NUM_VERTS ${numVerts}
static const float coastline_uv[COASTLINE_NUM_VERTS * 2] = {
${lines.join('\n')}
};
`
}

async function main() {
  const geojson = await loadLandGeoJSON()
  const rings = collectRings(geojson)
  console.log(`[gen_coastline] ${rings.length} ring(s) within ${MARGIN_DEG}deg of the AOI`)

  const verts = []
  for (const ring of rings) verts.push(...ringToUVSegments(ring))
  const numSegments = verts.length / 4
  console.log(`[gen_coastline] ${numSegments} segment(s) within UV_MARGIN of the model footprint`)
  if (numSegments === 0) throw new Error('no coastline segments found near the AOI -- check geo_grid.mjs constants')

  await writeFile(OUTPUT_PATH, formatHeader(verts))
  console.log(`[gen_coastline] wrote ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error('[gen_coastline]', err)
  process.exit(1)
})
