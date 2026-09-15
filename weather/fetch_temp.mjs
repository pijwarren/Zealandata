#!/usr/bin/env node
/*
 * Fetches the latest global GFS 2m air temperature grid (same
 * gaia.nullschool.net repackaging as fetch_wind.mjs, just a scalar
 * product instead of a vector one), decodes it with the vendored
 * cambecc/earth scalarProduct codec, converts Kelvin -> Celsius, and
 * hands it to geo_grid.mjs's writeScalarGrid() to crop+rotate into the
 * model's local UV space and write temp_field.bin.
 *
 * This is GFS's 2m-above-ground air temperature, not a dedicated sea
 * surface temperature product -- gaia.nullschool.net doesn't mirror one.
 * Over open ocean it still tracks the water below closely enough to read
 * as "sea temperature" on the model, and it's also meaningful over land,
 * unlike a true SST field would be.
 *
 * No npm dependencies -- uses Node's built-in fetch (Node 18+).
 *
 * Run on a loop (see weather/README.md for the systemd timer setup) --
 * each run is cheap (~1MB fetch) and idempotent if no newer GFS run has
 * landed yet.
 */

import { decodeEpak } from './vendor/earth/codec/decoder.js'
import { scalarProduct } from './vendor/earth/product/scalarProduct.js'
import { writeScalarGrid } from './geo_grid.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const OUTPUT_PATH = path.join(__dirname, '..', 'temp_field.bin')
const GAIA_BASE = 'https://gaia.nullschool.net/data/gfs'
const MAX_LOOKBACK_STEPS = 16 // 3h steps -> 48h max lookback before giving up
const TEMPERATURE_SELECTOR = /temperature_height_above_ground/i

function tempUrlFor(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  return `${GAIA_BASE}/${yyyy}/${mm}/${dd}/${hh}00-temp-surface-level-gfs-0.5.epak`
}

function floorTo3HourSlot(date) {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3)
  return d
}

async function fetchLatestTemp() {
  let slot = floorTo3HourSlot(new Date())
  for (let i = 0; i < MAX_LOOKBACK_STEPS; i++) {
    const url = tempUrlFor(slot)
    const res = await fetch(url)
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const epak = decodeEpak(buf)
      const temp = scalarProduct(epak, TEMPERATURE_SELECTOR)
      return { temp, validTime: temp.validTime(), url }
    }
    slot = new Date(slot.getTime() - 3 * 3600 * 1000)
  }
  throw new Error(`No GFS temp data found in the last ${MAX_LOOKBACK_STEPS * 3}h`)
}

async function main() {
  const { temp, validTime, url } = await fetchLatestTemp()
  console.log(`[fetch_temp] using ${url}, validTime=${JSON.stringify(validTime)}`)
  const kelvinToCelsius = (k) => k - 273.15
  await writeScalarGrid(temp.field(), validTime, OUTPUT_PATH, kelvinToCelsius, 'fetch_temp')
}

main().catch((err) => {
  // Deliberately don't touch OUTPUT_PATH on failure -- projector.c just
  // keeps showing whatever grid it last loaded rather than erroring.
  console.error('[fetch_temp] failed:', err)
  process.exitCode = 1
})
