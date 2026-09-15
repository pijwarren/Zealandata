#!/usr/bin/env node
/*
 * Fetches the latest global GFS wind grid (NOAA public-domain model data,
 * repackaged by earth.nullschool.net as gaia.nullschool.net/data/gfs/...),
 * decodes it with the vendored cambecc/earth codec (see vendor/earth/),
 * and hands it to geo_grid.mjs's writeFieldGrid() to crop+rotate into the
 * model's local UV space and write wind_field.bin.
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

async function main() {
  const { wind, validTime, url } = await fetchLatestWind()
  console.log(`[fetch_wind] using ${url}, validTime=${JSON.stringify(validTime)}`)
  await writeFieldGrid(wind.field(), validTime, OUTPUT_PATH, SPEED_SCALE, 'fetch_wind')
}

main().catch((err) => {
  // Deliberately don't touch OUTPUT_PATH on failure -- projector.c just
  // keeps animating whatever grid it last loaded rather than erroring.
  console.error('[fetch_wind] failed:', err)
  process.exitCode = 1
})
