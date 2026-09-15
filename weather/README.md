# Live wind particles

Renders animated wind particles on the physical model, drawn natively by
`projector.c` (see its own top-of-file comment and the "wind" section
further down) rather than composited from an image. This directory is
just the data half: it fetches current global wind data and writes a
small binary grid file `projector.c` polls and animates from.

## How it fits together

```
fetch_wind.mjs  --(every ~15-30 min)-->  wind_field.bin  --(polled every ~2s)-->  projector.c
   (this dir)                          (repo root, gitignored)         (native particle render)
```

- **`fetch_wind.mjs`** fetches the latest global GFS wind grid from
  `gaia.nullschool.net` (NOAA public-domain model data, repackaged by
  earth.nullschool.net -- not a documented public API, but a stable-
  looking, long-lived path), decodes it with the vendored
  `vendor/earth/` codec, crops+rotates it into the model's own local UV
  space, and writes `../wind_field.bin`.
- **`vendor/earth/`** is a small, deliberately minimal subset of
  [cambecc/earth](https://github.com/cambecc/earth) (MIT licensed, the
  actual engine behind earth.nullschool.net) -- just the decode/
  interpolation modules, extracted from that site's own published source
  map. See `vendor/earth/LICENSE.md`.
- **`server.py`** surfaces a "Live Weather" tile in the browse UI
  whenever `wind_field.bin` exists, and flips `projector.c` into wind
  mode over the same IPC socket it already uses for playback control
  (`/api/weather/select` / `/api/weather/stop`). It never touches
  `wind_field.bin` itself.
- **`projector.c`** polls `wind_field.bin` and does the actual particle
  simulation/rendering, entirely independent of whether `fetch_wind.mjs`
  is currently running -- if it stops, the model just keeps animating
  from the last grid it loaded.

## Geographic alignment (confirmed against the physical print)

`fetch_wind.mjs`'s geographic constants: `CENTER_LON`/`CENTER_LAT` come
from `Hikurangi_3Dprint_AOI.shp` in the model's QGIS project. The
shapefile rectangle's own ~30 deg tilt turned out to be an artifact of
the QGIS canvas being rotated when it was drawn, *not* the model's real
orientation -- `MODEL_ROTATION_DEG` (120) and the `HALF_WIDTH_KM`/
`HALF_HEIGHT_KM` assignment (1014.05/518.75 -- the *larger* figure goes
to width) were instead set directly by the model's builder and confirmed
live against the physical print on 2026-09-15. Don't re-derive these from
the shapefile edge bearing or the raw OBJ file's own vertex extents --
both looked plausible but were wrong; `load_obj`'s second axis remap
((x,y,z) -> (y,x,-z), applied after its up-axis fix) transposes the
mesh's local X/Y in a way that's easy to miss reading the file cold.

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

`SPEED_SCALE` and `projector.c`'s `WIND_MAX_SPEED_UV` are pure visual
tuning (how fast particles appear to drift, and where the calm-to-storm
color ramp saturates) -- not physically meaningful, tune both together
against what actually looks good on the model.

## Running it

Needs Node.js 18+ on the Pi (no other dependency -- uses Node's built-in
`fetch`, and everything under `vendor/earth/` is plain JS with no
`npm install` step). Run on a loop via the included systemd timer
(adjust the `User=`/paths inside `zealandata-weather.service` first if
they don't match your install):

```bash
sudo cp weather/zealandata-weather.service weather/zealandata-weather.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zealandata-weather.timer
```

A failed fetch (network hiccup, GFS run not published yet) leaves
`wind_field.bin` untouched -- `projector.c` just keeps animating whatever
it last loaded rather than erroring or going blank.
