/*
 * Shared geographic transform + grid-file writer, used by all of
 * fetch_wind.mjs / fetch_waves.mjs / fetch_currents.mjs. Everything here
 * is data-source-agnostic: it just knows how to map the model's local UV
 * space onto real-world lon/lat and back, and how to sample an already-
 * decoded vector field (anything with `.bilinear(lon, lat)`) into the
 * binary grid file projector.c polls.
 *
 * Originally lived inline in fetch_wind.mjs; factored out once waves and
 * currents needed the exact same math with a different data source.
 */

import { writeFile, rename } from 'fs/promises'

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
// off the projection's grid axes -- that 30deg turned out to be a QGIS
// canvas-rotation artifact, not the model's real orientation.
//
// MODEL_ROTATION_DEG (120) and the HALF_WIDTH/HALF_HEIGHT_KM assignment
// (the *larger* figure goes to width) were set directly by the model's
// builder and confirmed live against the physical print on 2026-09-15 --
// see weather/README.md for why not to re-derive these from the
// shapefile edge bearing or the raw OBJ file's own vertex extents; both
// looked plausible but were wrong.
// ---------------------------------------------------------------------
export const CENTER_LON = 172.3178
export const CENTER_LAT = -41.2562
export const HALF_WIDTH_KM = 1014.05
export const HALF_HEIGHT_KM = 518.75
export const MODEL_ROTATION_DEG = 120
export const FLIP_X = false
export const FLIP_Y = false

export const GRID_W = 64
export const GRID_H = 48

const KM_PER_DEG_LAT = 111.32

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

// World (east, north) native units/s -> model-local (u, v) UV-per-second.
// speedScale is a per-data-source visual tuning knob (real-world
// magnitudes differ wildly between wind m/s, wave "period", and current
// m/s) -- not physically meaningful, just how fast things visibly move
// on the model.
function worldToLocalVelocity(u, v, speedScale) {
  let [lu, lv] = rotateCCW(u, v, MODEL_ROTATION_DEG)
  if (FLIP_X) lu = -lu
  if (FLIP_Y) lv = -lv
  return [lu * speedScale, lv * speedScale]
}

/**
 * Samples `field` (anything with `.bilinear(lon, lat) -> [u, v]`) across
 * the model's local UV grid and writes the binary grid file projector.c
 * polls: header (uint32 grid_w, uint32 grid_h, double valid_time_unix,
 * all little-endian) + grid_w*grid_h*2 float32 (u, v) values, written
 * atomically (temp file + rename).
 *
 * @param field decoded vector field, e.g. wind.field() / oscarField.field()
 * @param validTime {year,month,day,hour,minute,second} as returned by the
 *        decoder's own validTime() (already in the vendored utc.parts()
 *        shape)
 * @param outputPath absolute path to write to
 * @param speedScale visual tuning multiplier, see worldToLocalVelocity
 * @param label short tag for console logging, e.g. "fetch_wind"
 */
export async function writeFieldGrid(field, validTime, outputPath, speedScale, label) {
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
      const [lu, lv] = worldToLocalVelocity(uv[0], uv[1], speedScale)
      data[idx] = lu
      data[idx + 1] = lv
    }
  }
  if (nanCount > 0) {
    console.warn(`[${label}] ${nanCount}/${GRID_W * GRID_H} grid cells had no data (out of model coverage?)`)
  }

  const header = Buffer.alloc(4 + 4 + 8)
  header.writeUInt32LE(GRID_W, 0)
  header.writeUInt32LE(GRID_H, 4)
  header.writeDoubleLE(Date.UTC(
    validTime.year, validTime.month - 1, validTime.day,
    validTime.hour, validTime.minute, validTime.second
  ) / 1000, 8)

  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const out = Buffer.concat([header, body])

  const tmpPath = outputPath + '.tmp'
  await writeFile(tmpPath, out)
  await rename(tmpPath, outputPath) // atomic on the same filesystem
  console.log(`[${label}] wrote ${out.length} bytes to ${outputPath}`)
}
