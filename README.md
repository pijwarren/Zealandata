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
  polling `/api/status` once a second to stay in sync.

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

Progress is tracked per file path, shared by everyone on the network (this
is a single shared Pi + projector, not a multi-user login system).

## Pinning a hero video

The banner at the top of the browse page normally picks itself — the most
recent Continue Watching item, or the first item of the first category if
nothing's in progress. The ★ button in the now-playing dock lets you
override that: while something's playing, tap it to pin that item as the
hero permanently (tap again to unpin and go back to the automatic pick).
Persists across restarts (stored in `hero.json`, gitignored like
`progress.json`). If the pinned file is later removed from the library, it
just falls back to the automatic pick again rather than showing nothing.

## Admin mode (renaming videos)

Set `ZEALANDATA_ADMIN_PIN` to a 4-digit PIN to unlock a small admin mode
in the web UI — off entirely (no admin-mode UI, no endpoints active)
until you set one:
```
Environment=ZEALANDATA_ADMIN_PIN=1234
```
"Unlock admin mode" in Settings prompts for the PIN; once entered
correctly, every poster in the browse grid grows a small ✎ button (on
hover) that lets you rename it. The PIN itself is only held in that
browser tab's memory — never stored — and is re-checked by the server on
every rename request, so it isn't enough to just flip something in
devtools.

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

Set `ZEALANDATA_LOOP_SELECTED=1` to loop the video indefinitely instead —
useful for something like a seismic animation meant to run continuously
once chosen. The loop button in the dock also lets you flip this on or off
per-video at any point during playback, regardless of the env var default.
Either way, this only applies to a deliberate selection — the
screensaver's own random picks are never looped or held open, since
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
- **Security**: this has no authentication and is meant for a trusted
  office/home LAN only. Don't expose it to the internet (port-forwarding it
  through your router, for instance).
- **Extending it**: obvious next steps if you want them later — fetching
  real posters/metadata from a service like TMDB by filename, subtitle
  file (.srt) detection, or a search box in the header.
