# Zealandata

A Netflix / Apple TV-style browser UI for a media library stored on a
Raspberry Pi. The catch, and the whole point: the browser is just a
**remote control**. When you tap Play on your phone or laptop, the video
plays out of the **Pi's own HDMI port**, straight to whatever's plugged
into it (a projector, a TV, etc.) — not streamed into your browser tab.

```
 phone/laptop  --(HTTP, local wifi/LAN)-->  Flask server on Pi  --(spawns)--> mpv --(HDMI)--> projector
```

## How it works

- **`server.py`** — a small Flask app. It scans a media folder, generates
  poster thumbnails with `ffmpeg`, and serves a JSON API + the web UI.
- The server starts a single **`mpv`** (a lightweight, very capable video
  player) full-screen for the whole life of the service, pointed at the
  Pi's real display output. When you press Play, it tells that same mpv
  process to load your video over mpv's JSON IPC socket — the same socket
  is used to pause/seek/stop, and to read back playback position for the
  progress bar.
- The web page (`templates/index.html`, `static/app.js`, `static/style.css`)
  is a hero banner + poster rows + a persistent "now playing" dock bar,
  polling `/api/status` once a second to stay in sync. The dock itself is
  always on screen, even with nothing selected ("Nothing playing," controls
  dimmed) — it doesn't pop in and out, and its controls only ever act on a
  deliberate selection, never on whatever the screensaver happens to be
  showing.
- **Poster clicks are two-step**: clicking a poster once selects it (a
  highlighted border, a filled play glyph) rather than playing immediately —
  clicking that same poster again, or the hero's own Play button, is what
  actually starts it. Clicking elsewhere, or selecting a different poster,
  clears the selection. This is meant to guard against an accidental tap
  while browsing/scrolling; the restart and rename buttons on a poster
  remain single-click, since they're explicit, deliberately-placed controls
  rather than the poster itself.
- **Selecting a poster previews it in the hero area** — a full-res banner
  image (generated on demand and cached, same as a pinned hero) plus its
  title/category/description, so you can click through several posters and
  read about them before deciding what to play. Clearing the selection
  reverts the hero back to its normal pick (the pinned hero, or the most
  recent continue-watching item, or the first item in the library).

### About the current visual design

The UI (colors, hero banner, settings drawer) is ported from a design built
in Claude Design. A few deliberate deviations from
that source design, worth knowing if you're comparing against it:

- **Poster aspect ratio is square (1:1)**, not the 16:9 the design file
  specifies — kept square on purpose to match the physical 3D-printed
  terrain output rather than the literal import. One line in
  `static/style.css` (`.card { aspect-ratio: ... }`) flips it back to 16/9
  if you'd rather match the source design exactly.
- **No external fonts.** The design pulls "Inter" from Google Fonts CDN;
  this Pi never has internet access (ad-hoc wifi hotspot), so a system font
  stack approximating it is used instead.
- **"More Info" button omitted** from the hero — the design included one,
  but there's no secondary info view to link it to yet, so it'd be a dead
  button. Easy to add if a real use for it comes up.
- **The "now playing" surface is the original floating dock bar, not the
  design's full-screen takeover** — restyled with the new color system and
  components, but kept as a persistent bottom bar rather than a modal view.
  This was a deliberate choice after trying the full-screen version: a
  floating dock lets you keep browsing the library while glancing at
  what's currently playing, which matters more for a control-tablet
  workflow than the more cinematic full-screen treatment. The design's
  hero banner and settings drawer are otherwise unchanged from the import.
- **Idle screensaver is now live-toggleable**, not just an env var at
  startup — a single click on the "Screensaver on/off" pill in the top bar
  flips it, backed by a small `/api/screensaver` GET/POST pair.

## 1. Install dependencies on the Pi

```bash
sudo apt update
sudo apt install -y mpv ffmpeg python3-pip
pip3 install flask
```

## 2. Copy the project onto the Pi

Copy this whole `zealandata/` folder to e.g. `/home/pi/zealandata`, and put your
video files (mp4/mkv/avi/mov/m4v/webm/ts) anywhere under a media folder,
e.g. `/home/pi/media` (subfolders are fine, it scans recursively).

## 3. Choose how mpv will output video

You have two options — pick based on how your Pi is set up:

**A) Headless (recommended for a dedicated projector box)**
Use Raspberry Pi OS **Lite** (no desktop). mpv draws directly to the
screen via DRM/KMS — lower overhead, boots straight to the picture, no
desktop environment needed.
Set `ZEALANDATA_USE_DRM=1` (already the default in `zealandata.service`).
Your user needs access to the video/render devices:
```bash
sudo usermod -aG video,render pi
```

**B) Desktop session**
If you're running the full Raspberry Pi OS desktop, mpv will play on
whatever X11 display you point it at. Set `ZEALANDATA_USE_DRM=0` and
`ZEALANDATA_DISPLAY=:0` (or whatever your session's DISPLAY is) in the
service file.

## 4. Run it

Quick test run:
```bash
cd /home/pi/zealandata
ZEALANDATA_MEDIA_DIR=/home/pi/media ZEALANDATA_USE_DRM=1 python3 server.py
```
Then from any device on the same network, browse to:
```
http://<pi-ip-address>:8000
```

## 5. Start automatically on boot

Edit the paths/user in `zealandata.service` if needed, then:
```bash
sudo cp zealandata.service /etc/systemd/system/zealandata.service
sudo systemctl daemon-reload
sudo systemctl enable --now zealandata
```
Check status/logs with `systemctl status zealandata` and `journalctl -u zealandata -f`.

## Projection mapping onto a physical 3D model

Instead of mpv, HDMI output can instead be a Chromium kiosk rendering a
Three.js scene that texture-maps the current video onto a 3D model (e.g. a
3D-printed relief map) — for projecting video onto the physical object so
it lines up with it, rather than onto a flat screen/wall.

Set `ZEALANDATA_RENDER_BACKEND=webgl` and `ZEALANDATA_PROJECTION_OBJ=/path/to/model.obj`
(defaults to `static/projection_model.obj` if unset — falls back to a flat
placeholder plane if that file doesn't exist, so the rest of the pipeline
is still testable without a real model). Point a fullscreen Chromium kiosk
at `http://localhost:8000/projection` instead of relying on mpv to own the
display — e.g.:
```bash
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-session-crashed-bubble http://localhost:8000/projection
```
`--autoplay-policy=no-user-gesture-required` matters: without it, Chromium
blocks the page's own (unmuted) video.play() calls, and playback will sit
paused until someone presses Play from the dock a second time.

The video is projected onto the model top-down (like sunlight), using the
model's own footprint rather than whatever UVs the OBJ file happens to
carry — works whether or not the export has a sensible texture map. Scale,
rotation, and X/Y offset are calibrated live from the web UI's admin panel
("Projection mapping" in Settings, once admin mode is unlocked) — nudge the
sliders while watching the actual projector output until the video lines
up with the physical print.

Screensaver shuffling, the spinner transition, resume, and progress
tracking all work identically to the mpv backend — none of that logic
changed, only where the actual pixels end up.

### Running it on boot

The kiosk needs three packages the mpv backend doesn't. Chromium can't
draw to a bare console: its Wayland backend needs *some* compositor, so
`cage` (a minimal single-window one) provides it, and `seatd` is what
lets cage take the display without running as root:

```bash
sudo apt install -y chromium cage seatd
sudo systemctl enable --now seatd
# cage needs a real VT, so nothing else may hold tty1
sudo systemctl disable getty@tty1
```

`seatd` grants access via the `video` group, which the service user must
be in (`sudo usermod -aG video pj`).

Then install both units — the server and the kiosk are separate services
because only the kiosk touches the display:

```bash
sudo cp zealandata-warped.service zealandata-warped-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zealandata-warped zealandata-warped-kiosk
```

Only one backend can own HDMI at a time, so disable the mpv one:
```bash
sudo systemctl disable --now zealandata
```

### Performance on a Raspberry Pi 4

A Pi 4 cannot draw this at 1080p in real time. Measured with a 30fps
source, the projection page renders at ~11fps at full resolution — the
video decodes fine (hardware H.264 via `/dev/video10`, playback tracks
real time), but two of every three frames never reach the screen. Check
it live at `/api/projection/stats`, which reports the render rate and
the model's vertex count.

Two things dominate, and both are worth knowing before trying to
optimise the wrong one:

- **Render resolution.** The *Quality* slider in the admin panel draws
  the canvas below native and scales it up. 50% takes ~11fps to ~25fps.
  Softness costs little when the image lands on a relief model.
- **Source video resolution.** Every decoded frame is uploaded to a GPU
  texture, and that cost scales with pixel count no matter how
  efficiently it decoded. At 50% quality: a 1080p source renders at
  ~23fps, 720p at ~33fps, 960x540 at ~37fps.

So **re-encode sources to 720p H.264** — it's the single biggest win:
```bash
ffmpeg -i in.mov -vf scale=1280:-2 -c:v libx264 -preset slow -crf 20 \
  -pix_fmt yuv420p -movflags +faststart out.mp4
```
Keep H.264: it's the only codec with hardware decode here. H.265 falls
back to software in practice, and VP9/AV1 have no hardware support on a
Pi 4 at all. Bitrate doesn't affect render performance, so optimise it
for quality freely.

Model complexity matters *less* than it appears: at full resolution,
dropping from 210k faces to two triangles gained only ~2fps, because the
GPU was fill-rate bound. It only starts to matter once the Quality
slider has lifted that ceiling — which is why the geometry is indexed at
load (`mergeVertices`), since OBJLoader hands back non-indexed meshes
and a 210k-face model would otherwise be drawn as ~632k vertices instead
of ~106k.

## Browsing from a tablet, phone, or laptop

The server listens on every network interface by default (not just the Pi
itself), so any device on the same wifi/LAN — a tablet in a meeting room,
someone's laptop, whatever — can just open a browser and go to:
```
http://<pi-ip-address>:8000
```
No app, no install — it's a normal web page.

**Finding the Pi's IP address**, if you don't already know it:
```bash
hostname -I
```
run on the Pi itself (over SSH or with a keyboard/monitor attached), or
check your router's list of connected devices. It'll look something like
`192.168.1.42` — that, plus the port, is the full address, e.g.
`http://192.168.1.42:8000`.

**A few things worth knowing:**
- The IP address can change if your router reassigns it (common with
  default DHCP settings). If it keeps changing, set a static/reserved IP
  for the Pi in your router's settings, or a static DHCP lease, so the
  address doesn't move around. Alternatively, most routers and mDNS-aware
  networks will resolve `http://<hostname>.local:8000` (whatever you set
  the Pi's hostname to during setup) without needing to know the IP at all.
- Firewall: Raspberry Pi OS doesn't enable a firewall by default, so
  nothing extra is usually needed. If you've turned on `ufw` or similar,
  allow the port: `sudo ufw allow 8000`.
- The tablet just needs to be on the **same** network as the Pi — this
  isn't set up for access from outside your building/network, and
  shouldn't be exposed to the internet (see the security note below).
- Want a different port than 8000 (say, to avoid clashing with something
  else on your network, or just a number that's easier to remember)? Set
  `ZEALANDATA_PORT` — e.g. `Environment=ZEALANDATA_PORT=12345` in
  `zealandata.service` — and browse to that port instead.

### Ad-hoc setup (Pi broadcasts its own wifi, no router involved)

If there's no existing wifi network to join — e.g. this is a standalone
kit that gets carried between rooms — the Pi can broadcast its own network
instead, and tablets connect directly to it.

On Raspberry Pi OS Bookworm and later (NetworkManager, the current
default), this needs no extra packages:
```bash
sudo nmcli device wifi hotspot ifname wlan0 ssid "Zealandata" password "choose-a-password"
```
Password needs to be at least 8 characters. This creates and immediately
activates a WPA2-protected network, saved as a connection profile that
reconnects automatically on every boot (check with `nmcli connection show`
— look for `autoconnect: yes` next to the Hotspot entry).

Find the address tablets should browse to:
```bash
ip addr show wlan0
```
Look for the `inet` line — NetworkManager's hotspot mode almost always
lands on `10.42.0.1`. On the tablet, join the "Zealandata" wifi network,
then browse to `http://10.42.0.1:8000` (or whatever address that command
actually showed).

Worth knowing: while the hotspot is active, the Pi itself has no internet
access (unless it's also plugged into ethernet, which can run alongside
the wifi hotspot fine). That's not a problem for Zealandata — everything
it needs is local — but matters if you SSH in for maintenance while it's
running this way.

## Continue Watching

While a video plays, the server checks in with mpv every 5 seconds and
saves the playback position to `progress.json` (next to `server.py`). When
you open Zealandata again, anything more than 10 seconds in — and not within
the last 5% of the runtime — shows up in a **Continue Watching** row at the
top, with a "time left" badge and a progress sliver on the poster. Tapping
it resumes ~3 seconds before where you left off. Once you cross that last
5%, it's dropped from the row automatically (counted as watched).

Resuming only ever happens from that row. Selecting the same video anywhere
else — the regular browse grid, or the hero banner's Play button, even if
it happens to be showing your in-progress pick — always starts it from the
beginning instead, without touching the saved progress (so it's still
there in Continue Watching afterward). The row also has its own explicit
↺ "start over" button, which *does* clear the saved progress, for when you
actually want to forget where you were.

Progress is tracked per file path, shared by everyone on the network (this
is a single shared Pi + projector, not a multi-user login system).

## Pinning a hero video

The banner at the top of the browse page normally picks itself — the most
recent Continue Watching item, or the first item of the first category if
nothing's in progress. The ★ button in the now-playing dock lets you
override that: while something's playing, tap it to pin that item as the
hero permanently (tap again to unpin and go back to the automatic pick).
Only visible in admin mode (below), so it can't be pinned by accident.
Persists across restarts (stored in `hero.json`, gitignored like
`progress.json`). If the pinned file is later removed from the library, it
just falls back to the automatic pick again rather than showing nothing.

## Admin mode (renaming videos, setting the hero banner, uploading files)

Set `ZEALANDATA_ADMIN_PIN` to a 4-digit PIN to unlock a small admin mode
in the web UI — off entirely (no admin-mode UI, no endpoints active)
until you set one:
```
Environment=ZEALANDATA_ADMIN_PIN=1234
```
Set the real value directly on the Pi's deployed
`/etc/systemd/system/zealandata.service`, not in this repo — a PIN
committed to git stays in its history even after you change it.

Five wrong guesses in a row from the same device locks out further
attempts for two minutes — enforced server-side per client IP, so it
can't be bypassed by just reloading the page.

"Unlock admin mode" in Settings brings up an on-screen number pad rather
than a plain text prompt (shakes and clears on a wrong entry, no need to
close and reopen to retry). Once unlocked, two things become available
that are hidden the rest of the time, specifically so neither happens by
accident:
- Every poster in the browse grid grows a small ✎ button (on hover) that
  renames it.
- The ★ "set as hero" button reappears in the now-playing dock.
- An "Upload video" field appears in Settings. Pick a file (any extension
  in `VIDEO_EXTS`) and optionally name a category — it's saved as a
  top-level subfolder of `MEDIA_DIR`, the same thing that drives a poster's
  category the rest of the time — then the library is rescanned
  automatically. Max upload size is 8GB by default; raise it with
  `ZEALANDATA_UPLOAD_MAX_MB` if needed.

The PIN itself is only held in that browser tab's memory — never
stored — and is re-checked by the server on every rename request, so it
isn't enough to just flip something in devtools.

Renaming only changes the **display title** — it never touches the
actual file on disk. Overrides are stored in `titles.json` (gitignored,
same pattern as `hero.json`/`progress.json`), keyed by the item's ID,
which is itself derived from the file's original path. That's a
deliberate choice: renaming the real file would change that ID and orphan
its thumbnail, watch progress, and hero pin, none of which is worth the
trade-off just to fix a badly-named source file.

## What happens when a video ends

By default (`ZEALANDATA_LOOP_SELECTED=0`), when a selected video reaches
the end, mpv pauses on the last frame rather than looping or falling back
to the screensaver — the scrub bar, seek buttons, and (for sequences)
frame-stepping all keep working normally on that final frame, so you can
scrub back into the video freely. It stays there until someone picks
something else, hits stop, or the idle timeout (below) fires.

Set `ZEALANDATA_LOOP_SELECTED=1` to loop every selected video indefinitely
instead — useful for something like a seismic animation meant to run
continuously once chosen. The loop button in the dock is a global toggle
on top of that: flipping it on or off carries forward into whatever gets
selected next, rather than resetting per-video — turn it on once and it
stays on across category browsing, hero picks, everything, until you turn
it off again. Either way, this only applies to a deliberate selection —
the screensaver's own random picks are never looped or held open, since
finishing normally is what lets the shuffle keep shuffling.

## Loading screen instead of the console flashing through

`server.py` starts exactly one `mpv` process, for the life of the service,
and never restarts it during normal operation — the idle image, a selected
video, and each screensaver pick are all switched by sending that same
process `loadfile` over its IPC socket rather than spawning/killing
separate `mpv` instances. On headless HDMI/DRM output (no window manager),
starting and stopping *separate* processes is the only thing that can let
the Linux console underneath (by default, a login prompt) flash into view
for a frame or two during the handoff — so avoiding that handoff
altogether, rather than trying to time it tightly, is what actually keeps
the console hidden. There are still two distinct gaps this covers:

**At boot** (before `zealandata.service` itself has even started) —
`zealandata-splash.service` shows a static image via its own `mpv` from
very early in boot, and is automatically stopped by systemd the instant
`zealandata.service` starts — no custom code involved, just systemd's
native `Conflicts=`/`Before=`/`After=` unit ordering. Install it once:
```bash
cp loading.png zealandata-splash.service # adjust paths/User inside first
sudo cp zealandata-splash.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable zealandata-splash
```
(`zealandata.service` already references it via `Conflicts=`/`After=` — that
line is harmless even if you never install the splash service at all.)

**From then on** — set `ZEALANDATA_LOADING_IMAGE` to a real image path and
it's passed straight to the persistent `mpv` process as its startup file,
then held up (via `loadfile`) any time there's genuinely nothing else
queued: right after startup, whenever a video is explicitly stopped, and
whenever the screensaver is off. It's swapped out for the real thing the
instant something needs to play. Off by default — nothing changes unless
you set this.

A basic default `loading.png` (dark background, "Zealandata" wordmark,
matching the app's own color palette) is included — replace it with your
own artwork any time, it's just a static file.

If the persistent `mpv` process itself ever genuinely crashes (rare — normal
transitions never touch the process, only its IPC socket), a supervisor
thread notices and restarts it automatically, going back to the idle image
rather than leaving the console exposed. Check `journalctl -u zealandata`
if that ever happens repeatedly — it means something's wrong with `mpv`
itself, not with a particular video file.

## Spinner between transitions

Every HDMI transition — a selected video, each screensaver pick, the idle
image — briefly cuts to a small spinner animation (`static/spinner.mp4`,
8 round dots fading around a ring) before the real content loads, rather
than cutting straight to it. 1.5 seconds by default, tuned via
`SPINNER_HOLD_SECONDS` near the top of `server.py` (not an env var — edit
directly if you want it shorter/longer).

An earlier version of this cross-faded to black instead, by animating
mpv's `brightness` equalizer property. That turned out to be the wrong
tool for the job — it needed a rapid sequence of IPC property-set calls
per transition, which was fragile in practice (a stray malformed reply
from mpv could abort mid-ramp and leave the picture stuck dark) and looked
visibly choppy even once that was fixed. The spinner instead reuses the
exact same `loadfile` mechanism already used for the idle image, selected
videos, and screensaver picks — nothing exotic, no per-file properties
animated in a loop, so there's nothing new that can leave the display in a
broken state. Regenerate it any time with:
```bash
# 1. a small round dot, alpha-masked so it composites cleanly
ffmpeg -f lavfi -i color=c=white:s=16x16 -frames:v 1 -update 1 -vf \
  "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-8,Y-8),7),255,0)'" \
  circle.png

# 2. composite 8 copies of it around a ring, opacity fading like a comet trail
ffmpeg -f lavfi -i color=c=black:s=240x240 \
  -i circle.png -i circle.png -i circle.png -i circle.png -i circle.png -i circle.png -i circle.png -i circle.png \
  -filter_complex \
  "[1:v]format=rgba,colorchannelmixer=aa=1.0[d0];[2:v]format=rgba,colorchannelmixer=aa=0.863[d1];[3:v]format=rgba,colorchannelmixer=aa=0.745[d2];[4:v]format=rgba,colorchannelmixer=aa=0.627[d3];[5:v]format=rgba,colorchannelmixer=aa=0.510[d4];[6:v]format=rgba,colorchannelmixer=aa=0.392[d5];[7:v]format=rgba,colorchannelmixer=aa=0.275[d6];[8:v]format=rgba,colorchannelmixer=aa=0.176[d7];[0:v][d0]overlay=182:112[t0];[t0][d1]overlay=162:162[t1];[t1][d2]overlay=112:182[t2];[t2][d3]overlay=63:162[t3];[t3][d4]overlay=42:112[t4];[t4][d5]overlay=63:63[t5];[t5][d6]overlay=112:42[t6];[t6][d7]overlay=162:63[t7]" \
  -map "[t7]" -frames:v 1 -update 1 spinner_dot.png

# 3. spin that ring continuously, composited onto a full-screen black canvas.
#    rotate=...t/1.5 + exactly 45 frames at 30fps makes one full turn land
#    precisely at the end of SPINNER_HOLD_SECONDS (1.5s) -- keep these two
#    in sync if you change SPINNER_HOLD_SECONDS in server.py.
ffmpeg -f lavfi -i color=c=black:s=1920x1080:r=30 -loop 1 -i spinner_dot.png -filter_complex \
  "[1:v]format=rgba,rotate=2*PI*t/1.5:c=black@0:ow=240:oh=240[spin];[0:v][spin]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[out]" \
  -map "[out]" -frames:v 45 -r 30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart static/spinner.mp4

rm circle.png spinner_dot.png  # build artifacts, not needed once spinner.mp4 exists
```
The very first idle-image load right after mpv starts (fresh boot, or a
crash-restart) skips the spinner outright, since that's the highest-risk
moment to be touching a brand new mpv process before its DRM context has
settled.

## Idle timeout

If a video is left **paused** (not stopped) with no further interaction for
`ZEALANDATA_IDLE_TIMEOUT_SECONDS` (default 600 = 10 minutes), it
automatically stops and falls back to the screensaver. Off by default —
enable with:
```
Environment=ZEALANDATA_IDLE_TIMEOUT_ENABLED=1
Environment=ZEALANDATA_IDLE_TIMEOUT_SECONDS=600
```
This only watches for the "paused and abandoned" case — a video that's
actively playing (or looping) is left alone no matter how long it's been
since anyone touched a button; that's normal viewing, not idleness.

## Preview thumbnail in the web UI

The now-playing dock shows a small thumbnail of whatever's selected — the
same auto-generated poster image used in the browsing grid, not a live
video feed. It's just a static image the server already had on hand
rather than anything that depends on mpv being interactively
controllable.

(An earlier version of this tried to pull a live screenshot from mpv once
a second. That turned out to be unreliable — mpv's screenshot mechanism
can come back solid black with some hardware-decode setups, since the
decoded frame can end up sitting in a GPU/DRM buffer it can't read back
from. Showing the existing poster thumbnail instead is simpler and doesn't
have that failure mode.)

## Idle Screensaver

When nothing's been chosen, the Pi can shuffle through random videos from
your own library — muted by default — instead of sitting on a blank
screen. It's not a separate file you need to prepare; it just picks
randomly from whatever's already in your media folder. On by default —
toggle it live from the "Screensaver on/off" pill in the top bar, or set
its startup default here:
```
Environment=ZEALANDATA_SCREENSAVER_ENABLED=1
# Environment=ZEALANDATA_SCREENSAVER_MUTED=1
```

**On boot or a service restart**, the screensaver doesn't start shuffling
immediately — the loading image (if configured) is held for
`ZEALANDATA_IDLE_TIMEOUT_SECONDS` (default 600s = 10 min, the same value
the idle-timeout feature above uses) first, so a restart mid-event or
mid-setup doesn't suddenly start playing an unrelated video on screen.
This is a one-time startup delay only — every other idle transition (a
video ending, an explicit stop) still brings the screensaver back
immediately, same as always.

**To start it immediately** regardless of that delay (or any timeout),
hit the ▷ "Start screensaver" button in the top bar — it interrupts
whatever's currently selected and jumps straight into shuffling, turning
the screensaver on if it was off.
It starts right after boot, and comes back automatically a few seconds
after a video finishes, is stopped, or the idle timeout fires. It picks a
new random item (never immediately repeating the last one) each time a
pick ends, for as long as nothing's been explicitly chosen.

## Per-video descriptions, and supplementary docs/images

A video can carry a description (shown over the hero image when it's
selected in the browse grid) and a small set of extra files — a PDF of the
paper it's based on, reference images, figures — shown as chips in the
"now playing" dock while it plays. Clicking a chip opens it in an in-page
viewer, with prev/next arrows to flick through the rest.

For a plain video file, both live in a dedicated `<video-name>.attachments/`
folder next to it, rather than as loose files scattered through the
category folder:
```
media/
  Seismic/
    fault_lines_overview.mp4
    fault_lines_overview.attachments/
      description.txt              (shown as the hero description)
      source_paper.pdf
      fig2.png
```
Everything in there is optional and independent — a video can have just a
description, just attachments, both, or neither (in which case it needs no
`.attachments/` folder at all). File names inside it don't matter beyond
their extension (`.pdf`, `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp` for
attachments; exactly `description.txt` for the description).

For an image-sequence folder (see below), both instead live *inside* the
sequence's own folder, since that folder is already dedicated to that one
item:
```
media/
  Seismic/
    2016_kaikoura_sequence/
      frame_0001.png
      ...
      description.txt
      attachments/
        source_paper.pdf
```

**Migrating older libraries:** if you already have loose sidecar files
from before this folder convention existed (`fault_lines_overview.txt` /
`fault_lines_overview_fig2.png` sitting directly next to the video),
Zealandata cleans them up automatically — the next Rescan moves them into
`fault_lines_overview.attachments/` for you (with the description renamed
to `description.txt`), no manual reorganizing needed.

## Image sequences

If some of your data comes as a folder of numbered frames rather than a
video file — common for GIS/scientific renders — drop them in as their own
folder and Zealandata converts them to a video automatically the first time
it's scanned:
```
media/
  Seismic/
    2016_kaikoura_sequence/
      frame_0001.png
      frame_0002.png
      ...
      description.txt        (optional)
```
That whole folder becomes one library item — "2016 kaikoura sequence"
under the "Seismic" category — exactly like any other video, with its own
thumbnail, progress tracking, and continue-watching support.

**Requirements for a folder to be recognized as a sequence:**
- At least `ZEALANDATA_SEQUENCE_MIN_FRAMES` images (default 3)
- All frames the same format (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff` — pick
  one per sequence, not a mix)
- Nothing else in the folder besides the frames and an optional
  `description.txt`
- No subfolders inside it, other than a reserved `attachments/` one (see
  above)

Frames are read in filename order, so **zero-padded, consistently-named
files matter** (`frame_0001.png`, `frame_0002.png`, ... — not `frame_1.png`,
`frame_2.png`, ..., `frame_10.png`, which would sort wrong). The converted
video is cached under `static/sequence_cache/`; if you change the frames in
an existing sequence folder later, delete its cached file there (or the
whole folder) before hitting Rescan, the same way you'd clear a stale
thumbnail. Conversion frame rate is `ZEALANDATA_SEQUENCE_FPS` (default 12,
reasonable for scientific animation — raise it for smoother motion, lower
it if you have very few frames spanning a long story).

Every frame is encoded as its own keyframe (no inter-frame compression),
which is what makes the frame-stepping controls below exact rather than
approximate.

### Stepping through frames one at a time

The **‹ −1 / +1 ›** buttons in the dock step exactly one frame backward or
forward (not a time-based seek), for any video, not just sequences —
useful for lining up on an exact frame generally, and essential for a
short sequence where seconds aren't a meaningful unit at all. When you
play a sequence item specifically, the dock also swaps the usual scrub
bar for a "Frame 3 of 5" counter, so you always know exactly where you
are in a short clip. Stepping always leaves it paused on the frame you
land on.

## Categories from folders

Drop videos (or image-sequence folders, see above) into subfolders under
your media directory and each subfolder becomes its own shelf in the UI —
e.g.:

```
/home/pi/media/
  Comedy/
    the_office_pilot.mp4
  Onboarding/
    welcome.mp4
    it_security.mp4
  loose_video_at_the_top.mp4
```

produces a "Comedy" row, an "Onboarding" row, and an "Uncategorized" row for
anything sitting loose at the top level. Only the top-level folder name is
used as the category (so `Onboarding/2026/welcome.mp4` still counts as
"Onboarding" — deeper nesting isn't turned into sub-categories). Underscores
and hyphens in folder names are turned into spaces for display. If you don't
use subfolders at all, everything just shows up under one plain "Library"
shelf. Hit Rescan after adding or moving folders around.

### This library's 6 categories

The categories in active use here, each anchoring one of Earth Sciences
New Zealand's core science mission areas:

- **Geological Hazards** — risk reduction and response for earthquakes,
  volcanoes, landslides, and tsunamis (anchoring the GeoNet network)
- **Weather and Climate Hazards** — extreme weather, floods, droughts,
  wildfires, coastal hazards, and climate-driven extremes
- **Atmosphere and Climate** — greenhouse gases, low-carbon transitions,
  and long-term climate impacts
- **Land and Water** — water security, ecosystem health, and integrated
  catchment-to-coast management
- **Oceans and Fisheries** — sustainable marine environments, ecosystems,
  and fisheries management
- **Energy** — progress toward a secure, low-emissions, sustainable
  long-term energy system

Matching folder names under `MEDIA_DIR`: `Geological Hazards/`,
`Weather and Climate Hazards/`, `Atmosphere and Climate/`, `Land and Water/`,
`Oceans and Fisheries/`, `Energy/`. The category row-icon strip above
Continue Watching (see below) jumps straight to whichever of these has
content.

## Notes & tweaks

- **Thumbnails** are generated once per file (grabbed at the 1-minute mark,
  falling back to 2 seconds for short clips) and cached in
  `static/thumbnails/`. Hit "Rescan" in the UI after adding new files.
- **Fonts/CSS**: Inter (`static/fonts/`) is hosted locally rather than
  pulled from Google Fonts, so the UI works even if the Pi and client
  devices have no internet access — only the local network.
- **Remote control**: the dock bar's pause/seek/stop buttons call mpv over
  its local IPC socket, so multiple people on the network see the same
  live status (whoever presses pause, pauses it for everyone).
- **Security**: this has no authentication and is meant for a trusted
  office/home LAN only. Don't expose it to the internet (port-forwarding it
  through your router, for instance).
- **Extending it**: obvious next steps if you want them later — fetching
  real posters/metadata from a service like TMDB by filename, subtitle
  file (.srt) detection, or a search box in the header.
