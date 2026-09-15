#!/usr/bin/env node
/*
 * Fetches the latest global WaveWatch III (WW3) primary wave data
 * (NOAA public-domain model, repackaged by earth.nullschool.net as
 * gaia.nullschool.net/data/ww3/...), decodes it with the vendored
 * cambecc/earth codec, and hands it to geo_grid.mjs's writeFieldGrid()
 * to crop+rotate into the model's local UV space and write
 * waves_field.bin.
 *
 * buildWW3PrimaryWaves converts (wave direction, wave mean period) into
 * a synthetic (u, v) vector field -- u=-period*sin(dir), v=-period*cos(dir)
 * -- in the exact same shape wind's own field uses, so this reuses the
 * whole geo_grid.mjs pipeline unchanged.
 *
 * No npm dependencies -- uses Node's built-in fetch (Node 18+). Same
 * "walk backward until a run is found" pattern as fetch_wind.mjs, since
 * WW3 also refreshes every 3h.
 */

import { decodeEpak } from './vendor/earth/codec/decoder.js'
import { buildWW3PrimaryWaves } from './vendor/earth/product/ww3/ww3-primary.js'
import { writeFieldGrid } from './geo_grid.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Visual tuning, not physical -- wave "period" (a few to ~20s) happens to
// be a similar order of magnitude to wind's m/s, so start with the same
// scale as fetch_wind.mjs and re-tune once visible on hardware.
const SPEED_SCALE = 0.004

const OUTPUT_PATH = path.join(__dirname, '..', 'waves_field.bin')
const GAIA_BASE = 'https://gaia.nullschool.net/data/ww3'
const MAX_LOOKBACK_STEPS = 16 // 3h steps -> 48h max lookback before giving up

function wavesUrlFor(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  return `${GAIA_BASE}/${yyyy}/${mm}/${dd}/${hh}00-primary-wave-30m.epak`
}

function floorTo3HourSlot(date) {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3)
  return d
}

async function fetchLatestWaves() {
  let slot = floorTo3HourSlot(new Date())
  for (let i = 0; i < MAX_LOOKBACK_STEPS; i++) {
    const url = wavesUrlFor(slot)
    const res = await fetch(url)
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const epak = decodeEpak(buf)
      const waves = buildWW3PrimaryWaves(epak)
      return { waves, validTime: waves.validTime(), url }
    }
    slot = new Date(slot.getTime() - 3 * 3600 * 1000)
  }
  throw new Error(`No WW3 wave data found in the last ${MAX_LOOKBACK_STEPS * 3}h`)
}

async function main() {
  const { waves, validTime, url } = await fetchLatestWaves()
  console.log(`[fetch_waves] using ${url}, validTime=${JSON.stringify(validTime)}`)
  await writeFieldGrid(waves.field(), validTime, OUTPUT_PATH, SPEED_SCALE, 'fetch_waves')
}

main().catch((err) => {
  console.error('[fetch_waves] failed:', err)
  process.exitCode = 1
})
