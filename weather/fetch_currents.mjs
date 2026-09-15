#!/usr/bin/env node
/*
 * Fetches OSCAR ocean surface currents (repackaged by earth.nullschool.net
 * as gaia.nullschool.net/data/oscar/...), decodes with the vendored
 * cambecc/earth codec (buildOscar), and hands it to geo_grid.mjs's
 * writeFieldGrid() to write currents_field.bin.
 *
 * NOT a live data source -- checked 2026-09-15: the OSCAR catalog's most
 * recent entry is from 2024-05-07, over two years stale (the upstream
 * feed appears to have stopped updating). This is a one-shot fetch of
 * whatever the catalog's newest entry currently is, not scheduled on the
 * weather timer (see weather/README.md) -- there's no point polling a
 * source that doesn't change. Re-run manually if the catalog ever gets a
 * newer entry again. server.py/the UI surface this as "as of <date>"
 * rather than presenting it as live, using the validTime this script
 * embeds in the output file same as the other layers.
 *
 * No npm dependencies -- uses Node's built-in fetch (Node 18+).
 */

import { decodeEpak } from './vendor/earth/codec/decoder.js'
import { buildOscar } from './vendor/earth/product/oscar/oscar.js'
import { writeFieldGrid } from './geo_grid.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Visual tuning, not physical -- ocean currents (typically well under
// 1 m/s, rarely up to ~2 m/s) are much slower than wind's m/s range, so
// this is scaled up considerably from fetch_wind.mjs's 0.004 to look
// comparably lively. Re-tune once visible on hardware.
const SPEED_SCALE = 0.05

const OUTPUT_PATH = path.join(__dirname, '..', 'currents_field.bin')
const GAIA_BASE = 'https://gaia.nullschool.net/data/oscar'

async function fetchLatestCurrents() {
  const catalogRes = await fetch(`${GAIA_BASE}/oscar-catalog.json`)
  if (!catalogRes.ok) throw new Error(`catalog fetch failed: HTTP ${catalogRes.status}`)
  const catalog = await catalogRes.json()
  if (!catalog.length) throw new Error('OSCAR catalog is empty')
  // Catalog is sorted, YYYYMMDD-prefixed, oldest first -- last entry is
  // the newest available (matches the original app's own
  // lookupOscar(catalog, "now") default, see vendor/earth/product/oscar/oscar.js).
  const file = catalog[catalog.length - 1]
  const url = `${GAIA_BASE}/${file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const epak = decodeEpak(buf)
  const currents = buildOscar(epak)
  return { currents, validTime: currents.validTime(), url }
}

async function main() {
  const { currents, validTime, url } = await fetchLatestCurrents()
  console.log(`[fetch_currents] using ${url}, validTime=${JSON.stringify(validTime)} (NOTE: OSCAR data is stale/frozen, not live -- see top-of-file comment)`)
  await writeFieldGrid(currents.field(), validTime, OUTPUT_PATH, SPEED_SCALE, 'fetch_currents')
}

main().catch((err) => {
  console.error('[fetch_currents] failed:', err)
  process.exitCode = 1
})
