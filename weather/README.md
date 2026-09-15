# Live data layers (wind, waves, currents, temp)

Renders live data on the physical model, drawn natively by `projector.c`
(see its own top-of-file comment and the "wind" section further down)
rather than composited from an image -- animated particles for the three
vector layers (wind/waves/currents), a colour overlay for the one scalar
layer (temp). This directory is just the data half: small scripts fetch
current global data and write the small binary grid files `projector.c`
polls and renders from, switchable live from the browse UI's "Live
Weather" tile.

Two independent axes, not one exclusive layer picker: a particle layer
(wind/waves/currents, or none) and the scalar overlay (temp, or none) can
both be on at once -- e.g. wind particles animating over the temp colour
wash -- see "Two independent axes" below. Wind additionally comes at a
choice of altitude/pressure level (a slider in the UI); waves/currents
have no equivalent, being single-level by nature.

## How it fits together

```
fetch_wind.mjs     --(every ~3h, via the timer, once per level)--> wind_field.bin / wind_field_<level>.bin --\
fetch_waves.mjs    --(every ~3h, via the timer)-->  waves_field.bin                                          |
fetch_temp.mjs     --(every ~3h, via the timer)-->  temp_field.bin                                           +--(polled every ~2s)--> projector.c
fetch_currents.mjs --(run manually, not scheduled)-> currents_field.bin                                      /     (native render, whichever
   (this dir)                                    (repo root, gitignored)                                          particle layer + overlay are on)
```

- **`geo_grid.mjs`** is the shared piece: it knows how the model's local
  UV space maps onto real-world lon/lat (`CENTER_LON`/`LAT`,
  `HALF_WIDTH`/`HEIGHT_KM`, `MODEL_ROTATION_DEG` -- see "Geographic
  alignment" below), how to sample an already-decoded vector field into
  the grid file format the wind/waves/currents layers use
  (`writeFieldGrid()`), and the scalar equivalent for temp
  (`writeScalarGrid()`, one value per cell instead of a (u,v) pair). All
  four fetch scripts are thin wrappers around it: fetch+decode their own
  data source, then call whichever of those two the layer needs.
- **`fetch_wind.mjs`** fetches the latest global GFS wind grid from
  `gaia.nullschool.net/data/gfs/...` (NOAA public-domain model data,
  repackaged by earth.nullschool.net -- not a documented public API, but
  a stable-looking, long-lived path), decodes it with the vendored
  `vendor/earth/product/gfs/gfs-wind.js`, and writes `../wind_field.bin`.
  Takes an optional altitude/pressure level argument (`node
  fetch_wind.mjs 500hPa`; default `850hPa`, the original/only level
  before others existed, still written to the unsuffixed
  `wind_field.bin`) -- `surface`, `1000hPa`, `700hPa`, `500hPa`,
  `250hPa`, `70hPa`, `10hPa` each write their own `wind_field_<level>.bin`
  instead. `zealandata-weather.service` runs one invocation per level.
- **`fetch_waves.mjs`** — same pattern, WaveWatch III primary wave data
  from `gaia.nullschool.net/data/ww3/...`, decoded with
  `vendor/earth/product/ww3/ww3-primary.js` (converts wave direction +
  period into a synthetic (u,v) field, same shape wind already uses).
  Live, same ~3h cadence as wind.
- **`fetch_currents.mjs`** — OSCAR ocean currents from
  `gaia.nullschool.net/data/oscar/...`, decoded with
  `vendor/earth/product/oscar/oscar.js`. **Not live**: checked
  2026-09-15, the OSCAR catalog's newest entry is from 2024-05-07 and
  hasn't updated since (the upstream feed appears to have stopped). This
  is a one-shot fetch of whatever the catalog's newest entry currently
  is -- not scheduled on the timer, since polling a source that doesn't
  change has no point. `server.py`/the UI read the grid file's own
  embedded `valid_time` and label this layer "as of <date>" rather than
  presenting it as live; re-run manually
  (`sudo systemctl start zealandata-weather-currents.service`) if the
  catalog ever gets a newer entry again.
- **`fetch_temp.mjs`** — GFS 2m air temperature, same `gaia.nullschool.net`
  repackaging and ~3h cadence as wind, decoded with the vendored
  `scalarProduct.js` (a scalar decoder, vs. the vector ones the other
  three use) and converted Kelvin -> Celsius before writing
  `../temp_field.bin`. Not a dedicated sea-surface-temperature product --
  gaia doesn't mirror one -- but tracks it closely enough over open ocean
  to read as one on the model, and is also meaningful over land. Rendered
  by `projector.c` as a translucent colour overlay (blue..red across
  `TEMP_MIN_C`/`TEMP_MAX_C`, pure visual tuning, see that file), not
  particles -- there's no flow direction for a scalar field to animate.
- **`vendor/earth/`** is a small, deliberately minimal subset of
  [cambecc/earth](https://github.com/cambecc/earth) (MIT licensed, the
  actual engine behind earth.nullschool.net) -- just the decode/
  interpolation modules for these four products, extracted from that
  site's own published source map (`oscar.js` is further trimmed to just
  its decoder function, `buildOscar` -- see that file's own comment for
  why). See `vendor/earth/LICENSE.md`.
- **`server.py`**'s `WEATHER_LAYERS`/`SCALAR_LAYERS` surface one "Live
  Weather" tile in the browse UI whenever at least one file from either
  exists, with a chip strip (reusing the same strip a video's own
  supplementary docs/images use) that only enables layers with real
  data: particle chips (Wind/Waves/Currents, mutually exclusive --
  clicking the active one turns particles off) plus an independent Temp
  toggle, and a level slider under the chips while Wind is active.
  `/api/weather/select` ({"layer": "wind"/"waves"/"currents"/"none"}) and
  `/api/weather/overlay/select` ({"overlay": "temp"/"none"}) are the two
  independent axes; `/api/weather/wind-level` ({"level": "..."}) sets the
  altitude/pressure level and switches to wind if it wasn't already
  active; `/api/weather/stop` turns both axes off at once. All of these
  flip `projector.c`'s texture source over the same IPC socket playback
  control already uses -- none of them touch the grid files themselves.
- **`projector.c`** polls whichever files are currently selected (one
  particle layer, one scalar overlay, either/both/neither) and does the
  actual particle simulation/colour-overlay rendering, compositing both
  into one texture when both are on -- entirely data-agnostic (it
  doesn't know or care whether it's animating wind, waves, or currents,
  or whether the overlay is temperature specifically, just abstract
  (u,v)/scalar grids), and independent of whether the matching fetch
  script is currently running: if it stops, the model just keeps
  rendering from the last grid it loaded.

## Geographic alignment (confirmed against the physical print)

`geo_grid.mjs`'s constants: `CENTER_LON`/`CENTER_LAT` come from
`Hikurangi_3Dprint_AOI.shp` in the model's QGIS project. The shapefile
rectangle's own ~30 deg tilt turned out to be an artifact of the QGIS
canvas being rotated when it was drawn, *not* the model's real
orientation -- `MODEL_ROTATION_DEG` (120) and the `HALF_WIDTH_KM`/
`HALF_HEIGHT_KM` assignment (1014.05/518.75 -- the *larger* figure goes
to width) were instead set directly by the model's builder and confirmed
live against the physical print on 2026-09-15. Don't re-derive these from
the shapefile edge bearing or the raw OBJ file's own vertex extents --
both looked plausible but were wrong; `load_obj`'s second axis remap
((x,y,z) -> (y,x,-z), applied after its up-axis fix) transposes the
mesh's local X/Y in a way that's easy to miss reading the file cold.
These constants apply identically to all three layers -- there's nothing
wind-specific about them.

If the model geometry or its calibration ever changes enough to need
re-checking: `coastline_uv.h` in `projector/` (currently unused, kept for
reference) has NZ's coastline pre-transformed through this same
`geo_to_uv` math -- wiring it back into a bright-line debug overlay (it
was previously #included and drawn as `GL_LINES` in wind mode) is a fast
way to visually re-verify alignment without guessing from the particle
pattern alone. A real video frame (something already geographically
registered, like a tsunami simulation) is a much more reliable reference
for this than a static idle/loading image, which may have its own
independent orientation quirks unrelated to true geography.

Each script's own `SPEED_SCALE` and `projector.c`'s `WIND_MAX_SPEED_UV`
are pure visual tuning (how fast particles appear to drift, and where
the calm-to-storm color ramp saturates) -- not physically meaningful.
Wind and waves happen to have similar-magnitude natural units (m/s vs.
wave period in seconds) so started from the same scale; currents (much
slower, typically well under 1 m/s) needed a considerably larger one.
Tune per layer against what actually looks good on the model.

## Running it

Needs Node.js 18+ on the Pi (no other dependency -- uses Node's built-in
`fetch`, and everything under `vendor/earth/` is plain JS with no
`npm install` step). Wind + waves + temp run on a loop via the included
systemd timer (adjust the `User=`/paths inside both `.service` files
first if they don't match your install):

```bash
sudo cp weather/zealandata-weather.service weather/zealandata-weather.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zealandata-weather.timer
```

Currents is a one-shot install with no timer (see above for why):

```bash
sudo cp weather/zealandata-weather-currents.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start zealandata-weather-currents.service
```

A failed fetch (network hiccup, GFS/WW3 run not published yet) leaves
that layer's grid file untouched -- `projector.c` just keeps animating
whatever it last loaded for that layer rather than erroring or going
blank.
