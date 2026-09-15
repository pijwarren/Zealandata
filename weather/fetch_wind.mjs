#!/usr/bin/env node
/*
 * Fetches the latest global GFS wind grid (NOAA public-domain model data,
 * repackaged by earth.nullschool.net as gaia.nullschool.net/data/gfs/...),
 * decodes it with the vendored cambecc/earth codec (see vendor/earth/),
 * and hands it to geo_grid.mjs's writeFieldGrid() to crop+rotate into the
 * model's local UV space and write wind_field*.bin.
 *
 * Takes an optional altitude/pressure LEVEL argument (default "850hPa"),
 * one of LEVELS below -- the same set earth.nullschool's own UI offers.
 * Each level is a separate GFS product/URL and writes its own output
 * file, all polled independently by projector.c
 * (see its wind_level_t/"wind-level" IPC property): `node fetch_wind.mjs`
 * or `node fetch_wind.mjs 850hPa` writes wind_field.bin (unchanged
 * filename, this was the only level before levels existed);
 * `node fetch_wind.mjs surface` writes wind_field_surface.bin, etc.
 * weather/zealandata-weather.service runs one invocation per level.
 *
 * No npm dependencies -- uses Node's built-in fetch (Node 18+).
 *
 * Run on a loop (see weather/README.md for the systemd timer setup) --
 * each run is cheap (~500KB fetch) and idempotent if no newer GFS run has
 * landed yet.
 */

import { decodeEpak } from './vendor/earth/codec/decoder.js'
import { buildGFSWind } from './vendor/earth/product/gfs/gfs-wind.js'
import { writeFieldGrid } from './geo_grid.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Visual tuning, not physical: real GFS wind speeds (a few to ~25 m/s,
// far more at upper levels) would take literal hours to visibly cross
// the model at true scale, so this exaggerates apparent particle speed.
// One shared value across levels for now -- tune per-level here if the
// faster upper-atmosphere jets end up needing their own scale once
// visible on hardware.
const SPEED_SCALE = 0.004

// "surface" is a distinct GFS product (2m/10m diagnostic fields), not an
// isobaric level -- hence the different URL shape below. The rest are
// GFS's standard isobaric levels, same set gaia.nullschool.net mirrors
// and earth.nullschool's own UI exposes.
const LEVELS = ['surface', '1000hPa', '850hPa', '700hPa', '500hPa', '250hPa', '70hPa', '10hPa']
const DEFAULT_LEVEL = '850hPa'
const LEVEL = process.argv[2] || DEFAULT_LEVEL
if (!LEVELS.includes(LEVEL)) {
  console.error(`[fetch_wind] unknown level "${LEVEL}" -- expected one of ${LEVELS.join(', ')}`)
  process.exit(1)
}

// wind_field.bin is the original/default filename, predating multiple
// levels -- kept as-is for 850hPa rather than renaming it and needing to
// migrate projector.c's default/env-override path along with it.
const OUTPUT_PATH = path.join(__dirname, '..', LEVEL === DEFAULT_LEVEL ? 'wind_field.bin' : `wind_field_${LEVEL}.bin`)
const GAIA_BASE = 'https://gaia.nullschool.net/data/gfs'
const MAX_LOOKBACK_STEPS = 16 // 3h steps -> 48h max lookback before giving up

function windUrlFor(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const product = LEVEL === 'surface' ? 'wind-surface-level' : `wind-isobaric-${LEVEL}`
  return `${GAIA_BASE}/${yyyy}/${mm}/${dd}/${hh}00-${product}-gfs-0.5.epak`
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

async function main() {
  const { wind, validTime, url } = await fetchLatestWind()
  console.log(`[fetch_wind] level=${LEVEL} using ${url}, validTime=${JSON.stringify(validTime)}`)
  await writeFieldGrid(wind.field(), validTime, OUTPUT_PATH, SPEED_SCALE, 'fetch_wind')
}

main().catch((err) => {
  // Deliberately don't touch OUTPUT_PATH on failure -- projector.c just
  // keeps animating whatever grid it last loaded rather than erroring.
  console.error(`[fetch_wind] level=${LEVEL} failed:`, err)
  process.exitCode = 1
})
