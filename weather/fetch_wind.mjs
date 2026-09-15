#!/usr/bin/env node
/*
 * Fetches the latest global GFS wind grid (NOAA public-domain model data,
 * repackaged by earth.nullschool.net as gaia.nullschool.net/data/gfs/...),
 * decodes it with the vendored cambecc/earth codec (see vendor/earth/),
 * crops+rotates it into the projector model's own local UV space, and
 * writes a small binary grid file that projector.c polls and animates.
 *
 * No npm dependencies -- uses Node's built-in fetch (Node 18+).
 *
 * Run on a loop (see weather/README.md for the systemd timer setup) --
 * each run is cheap (~500KB fetch) and idempotent if no newer GFS run has
 * landed yet.
 */

import { decodeEpak } from './vendor/earth/codec/decoder.js'
import { buildGFSWind } from './vendor/earth/product/gfs/gfs-wind.js'
import { writeFile, rename } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------
// Geographic config -- describes how the model's local UV space (u,v in
// [0,1], same space the video shader drapes texture over: see
// projector.c's `aPos.xy / uModelSize + 0.5`) maps onto real-world
// lon/lat.
//
// CENTER_LON/CENTER_LAT/HALF_WIDTH_KM/HALF_HEIGHT_KM come from
// Hikurangi_3Dprint_AOI.shp (the model's real QGIS footprint polygon,
// NZGD2000 / NZ Continental Shelf 2000 Lambert Conformal Conic), reduced
// to plain lon/lat + real-world extent. It's a near-perfect rectangle
// (edge dot product ~0.001 against ~1e6 m sides) rotated exactly 30 deg
// off the projection's grid axes -- matching MODEL_ROTATION_DEG below
// exactly. Which km figure is "width" vs "height" was cross-checked
// against the OBJ mesh's own local extent ratio (see load_obj/m_size in
// projector.c): raw OBJ x:z extent is 1 : 1.955, and the shapefile's
// short:long edge ratio is 1037.5 : 2028.1 = 1 : 1.955 -- an exact
// match, so runtime local Y (height, post OBJ-axis-correction) is the
// long (~2028km) edge and local X (width) is the short (~1037.5km) one.
//
// Genuinely still unresolved without seeing this on the physical print:
// the *sign* of the rotation and which real-world corner lands at which
// UV corner (both depend on OBJ vertex winding/orientation, not
// derivable from the shapefile alone). FLIP_X/FLIP_Y are the same kind
// of empirical orientation knob this project already uses for video
// (uVidRotation/uVidFlipH/uVidFlipV) -- if wind ends up mirrored or
// off-axis once visible on the real print, tune these (and/or flip
// MODEL_ROTATION_DEG's sign) rather than the geometry math itself.
// ---------------------------------------------------------------------
const CENTER_LON = 172.3178
const CENTER_LAT = -41.2562
const HALF_WIDTH_KM = 518.75 // short edge / 2 -> local X
const HALF_HEIGHT_KM = 1014.05 // long edge / 2 -> local Y
const MODEL_ROTATION_DEG = 60 // the shapefile's ~30deg tilt is a QGIS canvas-rotation artifact, not the model's real orientation -- testing 60 (equivalently -300) per the model's builder
const FLIP_X = false
const FLIP_Y = false

const GRID_W = 64
const GRID_H = 48

// Visual tuning, not physical: real GFS wind speeds (a few to ~25 m/s)
// would take literal hours to visibly cross the model at true scale, so
// this exaggerates apparent particle speed. Tune once visible on hardware.
const SPEED_SCALE = 0.004

const OUTPUT_PATH = path.join(__dirname, '..', 'wind_field.bin')
const GAIA_BASE = 'https://gaia.nullschool.net/data/gfs'
const MAX_LOOKBACK_STEPS = 16 // 3h steps -> 48h max lookback before giving up

function windUrlFor(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  return `${GAIA_BASE}/${yyyy}/${mm}/${dd}/${hh}00-wind-isobaric-850hPa-gfs-0.5.epak`
}

function floorTo3HourSlot(date) {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3)
  return d
}

async function fetchLatestWind() {
  let slot = floorTo3HourSlot(new Date())
  for (let i = 0; i < MAX_LOOKBACK_STEPS; i++) {
    const url = windUrlFor(slot)
    const res = await fetch(url)
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const epak = decodeEpak(buf)
      const wind = buildGFSWind(epak)
      return { wind, validTime: wind.validTime(), url }
    }
    slot = new Date(slot.getTime() - 3 * 3600 * 1000)
  }
  throw new Error(`No GFS wind data found in the last ${MAX_LOOKBACK_STEPS * 3}h`)
}

function deg2rad(d) {
  return (d * Math.PI) / 180
}

// Rotates (x, y) clockwise by `deg` degrees.
function rotateCW(x, y, deg) {
  const t = deg2rad(deg)
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [x * c + y * s, -x * s + y * c]
}

// Inverse of rotateCW (rotates counter-clockwise by `deg`, i.e. undoes it).
function rotateCCW(x, y, deg) {
  const t = deg2rad(deg)
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [x * c - y * s, x * s + y * c]
}

const KM_PER_DEG_LAT = 111.32

function gridCellToLonLat(i, j) {
  let lx = (i / (GRID_W - 1) - 0.5) * 2 * HALF_WIDTH_KM
  let ly = (j / (GRID_H - 1) - 0.5) * 2 * HALF_HEIGHT_KM
  if (FLIP_X) lx = -lx
  if (FLIP_Y) ly = -ly
  const [dE, dN] = rotateCW(lx, ly, MODEL_ROTATION_DEG)
  const lat = CENTER_LAT + dN / KM_PER_DEG_LAT
  const lon = CENTER_LON + dE / (KM_PER_DEG_LAT * Math.cos(deg2rad(CENTER_LAT)))
  return [lon, lat]
}

// World (east, north) m/s -> model-local (u, v) UV-per-second.
function worldToLocalVelocity(u, v) {
  let [lu, lv] = rotateCCW(u, v, MODEL_ROTATION_DEG)
  if (FLIP_X) lu = -lu
  if (FLIP_Y) lv = -lv
  return [lu * SPEED_SCALE, lv * SPEED_SCALE]
}

async function main() {
  const { wind, validTime, url } = await fetchLatestWind()
  console.log(`[fetch_wind] using ${url}, validTime=${JSON.stringify(validTime)}`)

  const field = wind.field()
  const data = new Float32Array(GRID_W * GRID_H * 2)
  let nanCount = 0
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const [lon, lat] = gridCellToLonLat(i, j)
      const uv = field.bilinear(lon, lat)
      const idx = (j * GRID_W + i) * 2
      if (!uv || Number.isNaN(uv[0]) || Number.isNaN(uv[1])) {
        nanCount++
        data[idx] = 0
        data[idx + 1] = 0
        continue
      }
      const [lu, lv] = worldToLocalVelocity(uv[0], uv[1])
      data[idx] = lu
      data[idx + 1] = lv
    }
  }
  if (nanCount > 0) {
    console.warn(`[fetch_wind] ${nanCount}/${GRID_W * GRID_H} grid cells had no data (out of model coverage?)`)
  }

  // Header: uint32 grid_w, uint32 grid_h, double valid_time_unix (all little-endian).
  const header = Buffer.alloc(4 + 4 + 8)
  header.writeUInt32LE(GRID_W, 0)
  header.writeUInt32LE(GRID_H, 4)
  header.writeDoubleLE(Date.UTC(
    validTime.year, validTime.month - 1, validTime.day,
    validTime.hour, validTime.minute, validTime.second
  ) / 1000, 8)

  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const out = Buffer.concat([header, body])

  const tmpPath = OUTPUT_PATH + '.tmp'
  await writeFile(tmpPath, out)
  await rename(tmpPath, OUTPUT_PATH) // atomic on the same filesystem
  console.log(`[fetch_wind] wrote ${out.length} bytes to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  // Deliberately don't touch OUTPUT_PATH on failure -- projector.c just
  // keeps animating whatever grid it last loaded rather than erroring.
  console.error('[fetch_wind] failed:', err)
  process.exitCode = 1
})
