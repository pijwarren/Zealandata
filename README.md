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
- When you press Play, the server launches **`mpv`** (a lightweight, very
  capable video player) full-screen, pointed at the Pi's real display
  output. It talks to mpv afterwards over mpv's JSON IPC socket to
  pause/seek/stop, and to read back playback position for the progress bar.
- The web page (`templates/index.html`, `static/app.js`, `static/style.css`)
  is a poster grid + a "now playing" dock bar, polling `/api/status` once a
  second to stay in sync.

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

## NDI (sending the video feed over the network instead of HDMI)

`ZEALANDATA_OUTPUT_MODE` picks exactly one output — it's one or the other, not
both. A segmented HDMI/NDI switch in the top bar also lets you flip
between them live from the web UI, without touching the Pi — it stops
whatever's currently playing (with a confirmation if something's actively
running) and switches over. `ZEALANDATA_OUTPUT_MODE` just sets the mode Zealandata
starts up in; the switch overrides it at runtime, and reverts to the
env var's setting on the next restart of the service.

- `hdmi` (default): mpv plays full-screen out of the Pi's HDMI port, same
  as everything described above.
- `ndi`: nothing goes out the Pi's HDMI at all. Instead, ffmpeg pushes
  whatever's selected out as a live NDI network source, so other software
  on your network (vMix, OBS with the NDI plugin, NDI Studio Monitor, video
  walls, etc.) can pick it up.

**NDI mode is more involved to set up**, because NDI is a proprietary
protocol from Vizrt/NewTek — there's no `apt install ndi`. Here's what's
actually required:

1. **Download the NDI SDK for Linux** from [ndi.video](https://ndi.video/for-developers/ndi-sdk/)
   (free, but requires creating an account and accepting their license —
   this step can't be scripted). Get NDI SDK **v5 or later**, the first
   version with proper ARM64 builds for a Pi 4. Run their installer; note
   where it puts `libndi.so`.

2. **Build ffmpeg from source with NDI support.** The code for this
   (`libavdevice`'s NDI muxer) is already in mainline ffmpeg, just disabled
   by default — you opt in at build time once the SDK is present:
   ```bash
   sudo apt install -y build-essential pkg-config git
   git clone https://github.com/FFmpeg/FFmpeg.git ffmpeg-ndi
   cd ffmpeg-ndi
   ./configure --enable-libndi_newtek --enable-shared --prefix=/opt/ffmpeg-ndi
   make -j4
   sudo make install
   ```
   (You may need `PKG_CONFIG_PATH` pointed at wherever the NDI SDK installed
   its `.pc` file, and `LD_LIBRARY_PATH` set so this ffmpeg can find
   `libndi.so` at runtime — the SDK installer prints the exact paths.)
   This keeps your NDI-capable ffmpeg completely separate from the system
   `ffmpeg` Zealandata uses for thumbnails, so nothing else breaks.

3. **Switch Zealandata into NDI mode.** In `zealandata.service`:
   ```
   Environment=ZEALANDATA_OUTPUT_MODE=ndi
   Environment=ZEALANDATA_NDI_FFMPEG=/opt/ffmpeg-ndi/bin/ffmpeg
   Environment=ZEALANDATA_NDI_NAME=Zealandata
   ```
   Then `sudo systemctl daemon-reload && sudo systemctl restart zealandata`.
   You can leave `ZEALANDATA_USE_DRM`/`ZEALANDATA_DISPLAY` set to whatever they
   were — they're simply unused while `ZEALANDATA_OUTPUT_MODE=ndi`.

4. **Verify it** by running NDI Studio Monitor (or any NDI receiver) on
   another machine on the same network and confirming the source shows up
   (named `ZEALANDATA_NDI_NAME (video title)`) when you play something.

**How playback controls work in this mode:** there's no mpv running at
all, so pause/seek/stop are implemented directly against the ffmpeg
process:
- **Pause/resume** sends the process `SIGSTOP`/`SIGCONT` — the feed
  freezes on its last frame and picks back up on resume.
- **Seek** (±10s buttons, or dragging the scrub bar) restarts the ffmpeg
  process at the new position — there's a brief reconnect blip on the NDI
  feed each time you seek, unlike mpv's instant seeking on HDMI.
- **Position/duration** are tracked by Zealandata itself (via a one-time
  `ffprobe` per file at scan time, plus a wall-clock timer while playing),
  since ffmpeg has no live property-query protocol the way mpv does.
- A Pi 4 encoding NDI at full source resolution can get CPU-heavy. Set
  `ZEALANDATA_NDI_SCALE=1280x720` (or lower) to downscale the feed and keep
  things smooth.
- The screensaver's random-cycling videos also go out via NDI in this
  mode (same muted-by-default behavior, just no local picture).

## Continue Watching

While a video plays, the server checks in with mpv every 5 seconds and
saves the playback position to `progress.json` (next to `server.py`). When
you open Zealandata again, anything more than 10 seconds in — and not within
the last 5% of the runtime — shows up in a **Continue Watching** row at the
top, with a "time left" badge and a progress sliver on the poster. Tapping
it resumes ~3 seconds before where you left off. Once you cross that last
5%, it's dropped from the row automatically (counted as watched).

Progress is tracked per file path, shared by everyone on the network (this
is a single shared Pi + projector, not a multi-user login system).

## Looping the selected video

By default (`ZEALANDATA_LOOP_SELECTED=1`), once someone picks a video it
loops indefinitely rather than falling back to the random screensaver after
one play-through — useful for something like a seismic animation meant to
run continuously once chosen. It keeps looping until someone picks
something else, hits stop, or the idle timeout (below) kicks in. Set it to
`0` to go back to "play once, then screensaver" instead. This only applies
to a deliberate selection — the screensaver's own random picks are never
looped individually, since that's what keeps the shuffle actually shuffling.

If mpv ever exits unexpectedly while a video is supposed to be looping —
observed occasionally with very short clips — it's automatically
relaunched rather than silently leaving the dock stuck. If that happens
repeatedly for the same file (3 fast failures in a row), it gives up and
falls back to the screensaver instead of crash-looping forever, and logs
why via `journalctl -u zealandata`. mpv's own error messages are no longer
fully suppressed (previously `--really-quiet`, now `--msg-level=all=error`),
specifically so that log has something useful in it if this happens.

## Idle timeout

If a video is left **paused** (not stopped) with no further interaction for
`ZEALANDATA_IDLE_TIMEOUT_SECONDS` (default 300 = 5 minutes), it
automatically stops and falls back to the screensaver. Off by default —
enable with:
```
Environment=ZEALANDATA_IDLE_TIMEOUT_ENABLED=1
Environment=ZEALANDATA_IDLE_TIMEOUT_SECONDS=300
```
This only watches for the "paused and abandoned" case — a video that's
actively playing (or looping) is left alone no matter how long it's been
since anyone touched a button; that's normal viewing, not idleness.

## Live preview in the web UI

The now-playing dock includes a small live preview thumbnail — roughly
once a second, it pulls a fresh screenshot of whatever's actually showing
on the projector. Genuinely useful for confirming exactly which frame
something landed on after stepping through a short image sequence, without
needing to look up at the projector.

**HDMI mode only.** It works by asking mpv (which has an interactive
control socket) to take a screenshot on demand; NDI mode has no equivalent
easy mechanism (ffmpeg isn't interactively controllable that way), so the
preview area just stays hidden in NDI mode.

A couple of implementation details worth knowing:
- It's on-demand, not a background capture loop — a screenshot is only
  taken when a browser actually requests `/api/preview.jpg`, so it costs
  nothing when nobody's looking at the web UI.
- mpv always screenshots at full output resolution, which would mean
  serving a large JPEG roughly once a second over what may be a Pi-hosted
  wifi hotspot with several tablets connected. It's downscaled to
  `ZEALANDATA_PREVIEW_WIDTH` (default 320px wide) before being served, to
  keep that reasonable.
- Taking the screenshot doesn't cause any visible flicker on the actual
  projected output — it's a background operation, not an on-screen overlay.

**If the preview shows solid black:** this is a known interaction with
hardware-accelerated decoding. `--hwdec=auto` can decode straight into a
GPU/DRM buffer that mpv's screenshot mechanism can't always read back from
depending on which decode path it picked, producing a black frame instead
of an error. Two things to try, in order:
1. `ZEALANDATA_PREVIEW_SCREENSHOT_MODE` defaults to `window` (the
   composited output mpv actually rendered) specifically because it tends
   to be more reliable here than `video` (the raw decoded frame) — this is
   already the default, so if you're still seeing black, it didn't fully
   fix it for your setup.
2. If it's still black, the more reliable (but heavier) fix is forcing
   `--hwdec=auto-copy` instead of `--hwdec=auto` for mpv, which copies
   decoded frames back to normal memory instead of a zero-copy GPU/DRM
   buffer — trading a bit of CPU/GPU efficiency for every video filter and
   screenshot working correctly, including this one. That's not currently
   a separate environment variable; if `window` mode alone doesn't resolve
   it, let me know and I'll wire that up as a proper toggle rather than a
   blanket change to how all video decodes.

## Idle Screensaver

When nothing's been chosen, the Pi can shuffle through random videos from
your own library — muted by default — instead of sitting on a blank
screen. It's not a separate file you need to prepare; it just picks
randomly from whatever's already in your media folder. Off by default:
```
Environment=ZEALANDATA_SCREENSAVER_ENABLED=1
# Environment=ZEALANDATA_SCREENSAVER_MUTED=1
```
It starts right after boot, and comes back automatically a few seconds
after a video finishes, is stopped, or the idle timeout fires. It picks a
new random item (never immediately repeating the last one) each time a
pick ends, for as long as nothing's been explicitly chosen.

## Per-video descriptions

Drop a text file with the same name as a video (`fault_lines_overview.mp4`
+ `fault_lines_overview.txt`) and its contents show up under the title
whenever that video is playing — handy for giving scientific/educational
context a filename alone can't ("2016 Kaikōura earthquake aftershock
sequence, animated over 6 weeks"). For an image sequence folder, put a
`description.txt` *inside* the folder alongside the frames instead. Purely
optional — videos without a matching text file just show no description.

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
- No subfolders inside it

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

For a short sequence, seconds aren't a meaningful unit — ±10s or a scrub
bar is useless on a clip that's under a second long. When you play a
sequence item, the dock automatically swaps the usual seek buttons and
time bar for **‹ frame-back / frame-forward ›** buttons and a "Frame 3 of
5" counter instead, so you can step through and hold on exactly the frame
you want (handy when walking someone through what changed between two
specific frames). Stepping always leaves it paused on the frame you land
on. This only works in HDMI output mode — there's no equivalent in NDI
mode, since ffmpeg has no interactive step protocol the way mpv does.

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

## Notes & tweaks

- **Thumbnails** are generated once per file (grabbed at the 1-minute mark,
  falling back to 2 seconds for short clips) and cached in
  `static/thumbnails/`. Hit "Rescan" in the UI after adding new files.
- **Fonts/CSS** intentionally use only system fonts — no external CDN — so
  the UI works even if the Pi and client devices have no internet access,
  only the local network.
- **Remote control**: the dock bar's pause/seek/stop buttons call mpv over
  its local IPC socket, so multiple people on the network see the same
  live status (whoever presses pause, pauses it for everyone).
- **HDMI/NDI switch**: hidden from the web UI by default
  (`ZEALANDATA_SHOW_OUTPUT_TOGGLE=0`) since most deployments pick one
  output mode via `ZEALANDATA_OUTPUT_MODE` and never need to change it
  live. Set it to `1` to show the switch if you do want it available.
- **Security**: this has no authentication and is meant for a trusted
  office/home LAN only. Don't expose it to the internet (port-forwarding it
  through your router, for instance).
- **Extending it**: obvious next steps if you want them later — fetching
  real posters/metadata from a service like TMDB by filename, subtitle
  file (.srt) detection, or a search box in the header.
