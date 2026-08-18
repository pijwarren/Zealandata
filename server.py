"""
Zealandata server
=============
Serves a Netflix/Apple-TV style browsing UI over the local network.
Video playback does NOT happen in the browser — it happens on the Pi
itself, in one of two mutually exclusive output modes:

  "hdmi" (default) — mpv plays full-screen out of the Pi's HDMI port,
                      onto whatever's plugged in (e.g. a projector).
  "ndi"            — ffmpeg pushes the video out as a network NDI
                      source instead; nothing goes out the Pi's HDMI.

Only one is active at a time — this isn't a mirror of both. The starting
mode comes from ZEALANDATA_OUTPUT_MODE, but it can also be switched live from
the web UI if ZEALANDATA_SHOW_OUTPUT_TOGGLE=1 (a toggle stops whatever's
currently playing and switches over).

When nothing's been chosen, an optional screensaver mode cycles through
random videos from the library on whichever output mode is active,
muted by default, until someone picks something from the web UI.

Media can also come from image sequences: any leaf folder containing a run
of numbered images (frame_0001.png, frame_0002.png, ...) is automatically
converted to a video once (cached) and treated exactly like any other file.

Run with:  python3 server.py
Config via environment variables (see README.md).
"""

import os
import json
import socket
import signal
import shutil
import subprocess
import threading
import time
import random
import hashlib
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, render_template

# ---------------------------------------------------------------- config ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.environ.get("ZEALANDATA_MEDIA_DIR", "/home/pi/media")
THUMB_DIR = os.path.join(BASE_DIR, "static", "thumbnails")
SEQUENCE_CACHE_DIR = os.path.join(BASE_DIR, "static", "sequence_cache")
PROGRESS_FILE = os.path.join(BASE_DIR, "progress.json")
HERO_FILE = os.path.join(BASE_DIR, "hero.json")

MPV_SOCKET = "/tmp/zealandata-mpv.sock"
SCREENSAVER_SOCKET = "/tmp/zealandata-screensaver.sock"

# DISPLAY only matters if the Pi is running a desktop (X11) session.
# Ignored entirely when using headless DRM output (see README).
X_DISPLAY = os.environ.get("ZEALANDATA_DISPLAY", ":0")
USE_DRM = os.environ.get("ZEALANDATA_USE_DRM", "0") == "1"
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts"}

# Image sequences: a leaf folder containing this many (or more) images, all
# the same format, and nothing else but an optional description.txt, gets
# converted to a video once and cached under SEQUENCE_CACHE_DIR.
SEQUENCE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
SEQUENCE_MIN_FRAMES = int(os.environ.get("ZEALANDATA_SEQUENCE_MIN_FRAMES", "3"))
SEQUENCE_FPS = float(os.environ.get("ZEALANDATA_SEQUENCE_FPS", "12"))

# Output mode: "hdmi" (mpv, local display) or "ndi" (ffmpeg, network only).
# Mutually exclusive — set one, not both.
_mode_raw = os.environ.get("ZEALANDATA_OUTPUT_MODE", "").strip().lower()
if _mode_raw in ("hdmi", "ndi"):
    OUTPUT_MODE = _mode_raw
elif os.environ.get("ZEALANDATA_NDI_ENABLED", "0") == "1":
    OUTPUT_MODE = "ndi"  # back-compat with an earlier mirror-mode env var
else:
    OUTPUT_MODE = "hdmi"

output_mode_lock = threading.Lock()

# Whether the HDMI/NDI switch shows up in the web UI at all. Off by default
# — most deployments pick one mode and stick with it; the API endpoints
# still work either way if you want to script a switch.
SHOW_OUTPUT_TOGGLE = os.environ.get("ZEALANDATA_SHOW_OUTPUT_TOGGLE", "0") == "1"

# Screensaver: when nothing's been chosen, shuffle through random videos
# from the library itself on whichever output mode is active.
SCREENSAVER_ENABLED = os.environ.get("ZEALANDATA_SCREENSAVER_ENABLED", "0") == "1"
SCREENSAVER_MUTED = os.environ.get("ZEALANDATA_SCREENSAVER_MUTED", "1") == "1"

# Default behavior when a selected video reaches the end: mpv pauses on the
# last frame (see --keep-open=yes below), so it can be scrubbed back and
# forth rather than the screensaver kicking back in automatically. Set this
# to loop the video indefinitely instead — screensaver picks are never
# looped individually either way, only a deliberate selection.
LOOP_SELECTED_VIDEO = os.environ.get("ZEALANDATA_LOOP_SELECTED", "0") == "1"

# If something's left PAUSED (not stopped) for this long with no further
# interaction, automatically stop it and fall back to the screensaver.
# Doesn't affect actively-playing/looping video — only abandoned pauses.
IDLE_TIMEOUT_ENABLED = os.environ.get("ZEALANDATA_IDLE_TIMEOUT_ENABLED", "0") == "1"
IDLE_TIMEOUT_SECONDS = float(os.environ.get("ZEALANDATA_IDLE_TIMEOUT_SECONDS", "300"))

# NDI settings — only used when OUTPUT_MODE == "ndi". Requires a separately
# -built ffmpeg with NDI support (see README) — NOT the same ffmpeg used for
# thumbnails, since stock ffmpeg builds don't include the license-gated NDI
# muxer.
NDI_FFMPEG_BIN = os.environ.get("ZEALANDATA_NDI_FFMPEG", "ffmpeg-ndi")
NDI_SOURCE_NAME = os.environ.get("ZEALANDATA_NDI_NAME", "Zealandata")
# Optional "WxH" to downscale the NDI feed (e.g. "1280x720") to keep encoder
# CPU load reasonable on a Pi. Leave unset to send at source resolution.
NDI_SCALE = os.environ.get("ZEALANDATA_NDI_SCALE", "").strip() or None

# Resume threshold: only offer/apply "continue watching" if between these
# fractions of the way through (avoids resuming a 3-second stub, and avoids
# "resuming" something that's basically already finished).
RESUME_MIN_SECONDS = 10
RESUME_MAX_FRACTION = 0.95

os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(SEQUENCE_CACHE_DIR, exist_ok=True)

app = Flask(__name__)

mpv_process = None
mpv_lock = threading.Lock()
mpv_generation = 0  # bumped every time we start a new mpv playback
mpv_stop_requested = False  # set just before an intentional quit, so the
                             # watcher can tell "stopped on purpose" apart
                             # from "exited unexpectedly while looping"

screensaver_thread = None
screensaver_process = None
screensaver_lock = threading.Lock()
screensaver_stop_event = threading.Event()

# NDI playback state (used only when OUTPUT_MODE == "ndi"). Position is
# tracked with a wall-clock formula rather than an IPC query, since ffmpeg
# has no equivalent of mpv's property protocol.
ndi_lock = threading.RLock()
ndi_generation = 0
ndi_state = {
    "process": None,
    "media_id": None,
    "title": None,
    "path": None,
    "duration": None,
    "position_at_change": 0.0,
    "changed_at": 0.0,
    "paused": False,
}

# Metadata for whatever's currently playing (either backend) — mainly so
# /api/status can report a description without either backend needing to
# know what a "description" is.
meta_lock = threading.Lock()
current_media_meta = {"id": None, "title": None, "description": None, "is_sequence": False, "frame_count": None, "thumbnail": None}

# Last time any playback-control endpoint was hit — drives the idle timeout.
_interaction_lock = threading.Lock()
_last_interaction = time.monotonic()

_media_cache = {"items": None, "mtime": 0}

progress_lock = threading.Lock()
hero_lock = threading.Lock()

# ------------------------------------------------------------ progress ---


def _load_progress():
    if not os.path.exists(PROGRESS_FILE):
        return {}
    try:
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_progress_store(store):
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(store, f)
    os.replace(tmp, PROGRESS_FILE)


def get_progress(media_id):
    with progress_lock:
        return _load_progress().get(media_id)


def get_all_progress():
    with progress_lock:
        return _load_progress()


def update_progress(media_id, title, position, duration):
    with progress_lock:
        store = _load_progress()
        if duration and position is not None and position >= duration * RESUME_MAX_FRACTION:
            # basically finished watching -> drop from "continue watching"
            store.pop(media_id, None)
        elif position is not None and position >= RESUME_MIN_SECONDS:
            store[media_id] = {
                "title": title,
                "position": position,
                "duration": duration,
                "updated": time.time(),
            }
        _save_progress_store(store)


def clear_progress(media_id):
    with progress_lock:
        store = _load_progress()
        if store.pop(media_id, None) is not None:
            _save_progress_store(store)


def get_hero_id():
    """The explicitly-pinned hero item's ID, if one's been set — None means
    the frontend should fall back to its own automatic pick (most recent
    continue-watching item, else the first item of the first category)."""
    if not os.path.exists(HERO_FILE):
        return None
    try:
        with open(HERO_FILE, "r") as f:
            return json.load(f).get("id")
    except (json.JSONDecodeError, OSError):
        return None


def set_hero_id(media_id):
    with hero_lock:
        tmp = HERO_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"id": media_id}, f)
        os.replace(tmp, HERO_FILE)


# ------------------------------------------------------------- scanning ---


def _probe_duration(path):
    """Read a file's duration via ffprobe. Needed for NDI mode, since there's
    no mpv IPC to ask; also used to enrich items generally."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", path,
            ],
            capture_output=True, timeout=15, text=True,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def _read_text_file(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read().strip()
            return text or None
    except OSError:
        return None


def _find_description_file(dir_path):
    """Case-insensitive lookup for description.txt inside a folder."""
    try:
        for name in os.listdir(dir_path):
            if name.lower() == "description.txt":
                return os.path.join(dir_path, name)
    except OSError:
        pass
    return None


def _is_image_sequence_dir(dir_path):
    """A folder qualifies as an image sequence if it has no subfolders, at
    least SEQUENCE_MIN_FRAMES images all of the same extension, and nothing
    else besides those images and (optionally) a description.txt. Returns
    the sorted list of frame filenames, or None if it doesn't qualify."""
    try:
        entries = os.listdir(dir_path)
    except OSError:
        return None

    if any(os.path.isdir(os.path.join(dir_path, e)) for e in entries):
        return None

    files = [e for e in entries if os.path.isfile(os.path.join(dir_path, e))]
    image_files = [f for f in files if Path(f).suffix.lower() in SEQUENCE_EXTS]
    if len(image_files) < SEQUENCE_MIN_FRAMES:
        return None

    other_files = [f for f in files if f not in image_files]
    if any(not f.lower().endswith(".txt") for f in other_files):
        return None  # something unexpected in here besides frames + a .txt

    exts = {Path(f).suffix.lower() for f in image_files}
    if len(exts) != 1:
        return None  # mixed image formats -> ambiguous, skip

    return sorted(image_files)


def _convert_sequence_to_video(dir_path, ext, output_path):
    pattern = os.path.join(dir_path, f"*{ext}")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", str(SEQUENCE_FPS),
                "-pattern_type", "glob",
                "-i", pattern,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                # Every frame an I-frame, no B-frame reordering: these are
                # individually distinct images, not natural motion video, so
                # there's no compression benefit to inter-frame prediction —
                # and this is what makes frame-by-frame stepping (including
                # stepping backward) fast and exact.
                "-g", "1", "-keyint_min", "1", "-sc_threshold", "0", "-bf", "0",
                output_path,
            ],
            capture_output=True, timeout=600,
        )
    except Exception as exc:
        print(f"[sequence] failed to convert {dir_path}: {exc}")
        return False
    if not os.path.exists(output_path):
        stderr = result.stderr.decode(errors="replace")[-400:] if result and result.stderr else ""
        print(f"[sequence] ffmpeg produced no output for {dir_path}: {stderr}")
        return False
    return True


def _build_media_item(playback_path, metadata_path, description=None, frame_count=None):
    """playback_path is what mpv/ffmpeg actually opens; metadata_path is
    what the id/title/category get derived from (same as playback_path for
    a plain video file; the original frames folder for a converted image
    sequence, so its identity survives a cache rebuild). frame_count is set
    only for converted image sequences — it's what lets the UI show
    frame-by-frame stepping controls instead of (or alongside) the normal
    ±10s seek buttons for short sequences where seconds aren't meaningful."""
    media_id = hashlib.md5(metadata_path.encode()).hexdigest()[:12]
    thumb_path = os.path.join(THUMB_DIR, f"{media_id}.jpg")
    if not os.path.exists(thumb_path):
        _generate_thumbnail(playback_path, thumb_path)

    rel_path = os.path.relpath(metadata_path, MEDIA_DIR)
    rel_parts = rel_path.split(os.sep)
    if len(rel_parts) > 1:
        category = rel_parts[0].replace("_", " ").replace("-", " ").strip()
    else:
        category = "Uncategorized"

    return {
        "id": media_id,
        "title": Path(metadata_path).stem.replace(".", " ").replace("_", " "),
        "path": playback_path,
        "category": category,
        "duration": _probe_duration(playback_path),
        "description": description,
        "is_sequence": frame_count is not None,
        "frame_count": frame_count,
        "thumbnail": f"/thumbnails/{media_id}.jpg" if os.path.exists(thumb_path) else None,
    }


def _build_sequence_item(dir_path, frame_files):
    seq_id = hashlib.md5(dir_path.encode()).hexdigest()[:12]
    cached_video = os.path.join(SEQUENCE_CACHE_DIR, f"{seq_id}.mp4")
    if not os.path.exists(cached_video):
        ext = Path(frame_files[0]).suffix.lower()
        if not _convert_sequence_to_video(dir_path, ext, cached_video):
            return None
    description = _read_text_file(_find_description_file(dir_path))
    return _build_media_item(
        cached_video, dir_path, description=description, frame_count=len(frame_files)
    )


def _scan_dir(dir_path, items, is_root=False):
    try:
        entries = sorted(os.listdir(dir_path))
    except OSError:
        return

    if not is_root:
        frame_files = _is_image_sequence_dir(dir_path)
        if frame_files is not None:
            item = _build_sequence_item(dir_path, frame_files)
            if item:
                items.append(item)
            return  # don't descend into a recognized sequence folder

    for name in entries:
        full = os.path.join(dir_path, name)
        if os.path.isdir(full):
            _scan_dir(full, items)
        else:
            ext = Path(name).suffix.lower()
            if ext in VIDEO_EXTS:
                description = _read_text_file(os.path.splitext(full)[0] + ".txt")
                items.append(_build_media_item(full, full, description=description))


def _scan_media():
    items = []
    _scan_dir(MEDIA_DIR, items, is_root=True)
    items.sort(key=lambda i: i["title"].lower())
    return items


def get_media(force=False):
    if force or _media_cache["items"] is None:
        _media_cache["items"] = _scan_media()
    return _media_cache["items"]


def get_media_by_id(media_id):
    return next((i for i in get_media() if i["id"] == media_id), None)


def _generate_thumbnail(video_path, thumb_path):
    """Grab a frame partway into the file for the poster thumbnail. Uses the
    actual duration to pick a sensible timestamp rather than hardcoded
    absolute times — a fixed "1 minute in, then 2 seconds in" fallback (the
    previous approach) silently produces no thumbnail at all for anything
    shorter than 2 seconds, which is common for short test clips and some
    very brief image-sequence exports."""
    duration = _probe_duration(video_path)
    if duration and duration > 0.2:
        # ~10% in feels representative without needing to decode too far;
        # capped so a long file doesn't take forever to seek into, and kept
        # a hair before the true end so we don't land past the last frame
        timestamp = min(max(duration * 0.1, 0.1), 60.0, max(duration - 0.05, 0.0))
    else:
        timestamp = 0.0

    candidates = [timestamp]
    if timestamp > 0.05:
        candidates.append(0.0)  # last-resort: the very first frame

    for ts in candidates:
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y", "-ss", f"{ts:.3f}", "-i", video_path,
                    "-frames:v", "1", "-vf", "scale=440:-1", thumb_path,
                ],
                capture_output=True, timeout=30,
            )
        except Exception as exc:
            print(f"[thumbnail] failed for {video_path}: {exc}")
            return
        if os.path.exists(thumb_path):
            return

    print(f"[thumbnail] no frame could be extracted for {video_path} "
          f"(duration={duration}) — is it a valid, playable video file?")


# ------------------------------------------------------------- mpv IPC ---


def _mpv_send(command, sock_path):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(sock_path)
            s.sendall((json.dumps(command) + "\n").encode())
            resp = s.recv(4096)
            return json.loads(resp.decode()) if resp else None
    except (FileNotFoundError, ConnectionRefusedError, OSError, socket.timeout):
        return None


def mpv_send(command):
    return _mpv_send(command, MPV_SOCKET)


def _mpv_is_running():
    return mpv_process is not None and mpv_process.poll() is None


def _env_for_display():
    env = os.environ.copy()
    if not USE_DRM:
        env.setdefault("DISPLAY", X_DISPLAY)
    return env


# ------------------------------------------------------------- idle timer ---


def _mark_interaction():
    global _last_interaction
    with _interaction_lock:
        _last_interaction = time.monotonic()


def _idle_seconds():
    with _interaction_lock:
        return time.monotonic() - _last_interaction


def _idle_watcher_loop():
    """Runs for the life of the process. If something's been left PAUSED
    (not just playing/looping) for longer than IDLE_TIMEOUT_SECONDS with no
    further interaction, stop it and fall back to the screensaver."""
    while True:
        time.sleep(10)
        if not IDLE_TIMEOUT_ENABLED or _idle_seconds() < IDLE_TIMEOUT_SECONDS:
            continue

        if OUTPUT_MODE == "ndi":
            with ndi_lock:
                is_paused = ndi_state["paused"] and ndi_state["media_id"] is not None
            if is_paused:
                stop_ndi_playback()
                _mark_interaction()
        else:
            if _mpv_is_running():
                r = mpv_send({"command": ["get_property", "pause"]})
                if r and r.get("data"):
                    global mpv_stop_requested
                    mpv_stop_requested = True
                    mpv_send({"command": ["quit"]})
                    _mark_interaction()


# --------------------------------------------------------------- NDI ---


def _launch_ndi_process(path, start_seconds, label_suffix="", loop=False):
    cmd = [NDI_FFMPEG_BIN]
    if loop:
        cmd += ["-stream_loop", "-1"]
    if start_seconds and start_seconds > 0:
        cmd += ["-ss", str(start_seconds)]
    cmd += ["-re", "-i", path]
    if NDI_SCALE:
        w, h = NDI_SCALE.lower().split("x")
        cmd += ["-vf", f"scale={w}:{h}"]
    cmd += ["-pix_fmt", "uyvy422", "-f", "libndi_newtek", f"{NDI_SOURCE_NAME}{label_suffix}"]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _ndi_is_running():
    with ndi_lock:
        p = ndi_state["process"]
        return p is not None and p.poll() is None


def _ndi_get_position():
    with ndi_lock:
        if ndi_state["process"] is None:
            return None
        if ndi_state["paused"]:
            return ndi_state["position_at_change"]
        return ndi_state["position_at_change"] + (time.monotonic() - ndi_state["changed_at"])


def _stop_ndi_process_only():
    """Kill whatever ffmpeg process is running, without touching progress or
    the rest of ndi_state — used internally before starting a new one."""
    p = ndi_state["process"]
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            p.wait(timeout=5)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                p.kill()
            except ProcessLookupError:
                pass
    ndi_state["process"] = None


def start_ndi_playback(item, resume_seconds=0.0, loop=None):
    """Start (or restart, e.g. for a seek) NDI output for this item."""
    global ndi_generation
    if loop is None:
        loop = LOOP_SELECTED_VIDEO
    with ndi_lock:
        _stop_ndi_process_only()
        try:
            proc = _launch_ndi_process(item["path"], resume_seconds, f" ({item['title']})", loop=loop)
        except FileNotFoundError:
            print(
                f"[ndi] '{NDI_FFMPEG_BIN}' not found — is ZEALANDATA_NDI_FFMPEG set to "
                "an NDI-enabled ffmpeg build? See README.md."
            )
            proc = None
        ndi_state.update({
            "process": proc,
            "media_id": item["id"],
            "title": item["title"],
            "path": item["path"],
            "duration": item.get("duration"),
            "position_at_change": resume_seconds,
            "changed_at": time.monotonic(),
            "paused": False,
        })
        ndi_generation += 1
        gen = ndi_generation

    if proc is not None:
        threading.Thread(
            target=_watch_ndi_playback,
            args=(gen, item["id"], item["title"], proc),
            daemon=True,
        ).start()


def stop_ndi_playback():
    """User-initiated stop: save final progress, tear down, and (since this
    is a deliberate stop, not the watcher noticing a natural end) restart
    the screensaver ourselves."""
    _teardown_ndi_playback(restart_screensaver=True)


def _teardown_ndi_playback(restart_screensaver):
    with ndi_lock:
        media_id, title, duration = ndi_state["media_id"], ndi_state["title"], ndi_state["duration"]
        pos = _ndi_get_position()
        _stop_ndi_process_only()
        ndi_state.update({
            "media_id": None, "title": None, "path": None,
            "duration": None, "paused": False,
        })
    if media_id and pos is not None:
        update_progress(media_id, title, pos, duration)
    if restart_screensaver:
        start_screensaver()


def ndi_control_pause():
    with ndi_lock:
        p = ndi_state["process"]
        if p is None or p.poll() is not None:
            return None
        if ndi_state["paused"]:
            p.send_signal(signal.SIGCONT)
            ndi_state["changed_at"] = time.monotonic()
            ndi_state["paused"] = False
        else:
            ndi_state["position_at_change"] = _ndi_get_position()
            p.send_signal(signal.SIGSTOP)
            ndi_state["changed_at"] = time.monotonic()
            ndi_state["paused"] = True
        return ndi_state["paused"]


def _ndi_current_item():
    with ndi_lock:
        if ndi_state["media_id"] is None:
            return None, None
        item = {
            "id": ndi_state["media_id"], "title": ndi_state["title"],
            "path": ndi_state["path"], "duration": ndi_state["duration"],
        }
        return item, _ndi_get_position()


def ndi_control_seek(delta):
    """Seeking restarts the ffmpeg process at the new offset (input seek) —
    there's a brief reconnect on the NDI feed, unlike mpv's instant seek."""
    item, pos = _ndi_current_item()
    if item is None:
        return
    new_pos = max(0, (pos or 0) + delta)
    if item["duration"]:
        new_pos = min(new_pos, item["duration"])
    start_ndi_playback(item, resume_seconds=new_pos)


def ndi_control_seek_to(seconds):
    item, _pos = _ndi_current_item()
    if item is None:
        return
    new_pos = max(0, seconds)
    if item["duration"]:
        new_pos = min(new_pos, item["duration"])
    start_ndi_playback(item, resume_seconds=new_pos)


def _watch_ndi_playback(generation, media_id, title, process):
    """Periodically records progress. If this specific process is still the
    one referenced in ndi_state when it exits, that means it ended on its
    own (not superseded by a seek-restart, and not an explicit stop, both of
    which already replace/clear ndi_state) — so finalize progress and bring
    the screensaver back."""
    while process.poll() is None:
        time.sleep(5)
        with ndi_lock:
            still_this_one = ndi_state["process"] is process
            paused = ndi_state["paused"]
        if still_this_one and not paused:
            pos = _ndi_get_position()
            if pos is not None:
                update_progress(media_id, title, pos, ndi_state["duration"])

    with ndi_lock:
        natural_end = ndi_state["process"] is process
        final_pos = _ndi_get_position() if natural_end else None
        final_dur = ndi_state["duration"]
        if natural_end:
            ndi_state.update({
                "process": None, "media_id": None, "title": None,
                "path": None, "duration": None, "paused": False,
            })

    if natural_end:
        if final_pos is not None:
            update_progress(media_id, title, final_pos, final_dur)
        if generation == ndi_generation:
            start_screensaver()


# --------------------------------------------------------- screensaver ---


def start_screensaver():
    """Kick off a background thread that shuffles through random library
    videos on whichever output mode is active, one after another, until
    stop_screensaver() is called (i.e. someone picks something to watch)."""
    global screensaver_thread
    if not SCREENSAVER_ENABLED:
        return
    with screensaver_lock:
        if screensaver_thread is not None and screensaver_thread.is_alive():
            return  # already running
        screensaver_stop_event.clear()
        screensaver_thread = threading.Thread(target=_screensaver_loop, daemon=True)
        screensaver_thread.start()


def stop_screensaver():
    global screensaver_process
    screensaver_stop_event.set()
    thread = screensaver_thread
    if thread is not None:
        thread.join(timeout=8)
    with screensaver_lock:
        screensaver_process = None


def _screensaver_loop():
    """Runs in its own thread: repeatedly picks a random library video and
    plays it (muted by default) until it ends naturally, then picks another
    — until screensaver_stop_event is set. Uses mpv/HDMI or ffmpeg/NDI
    depending on OUTPUT_MODE. Individual screensaver picks are never looped
    — that's what keeps the shuffle actually shuffling."""
    global screensaver_process
    last_id = None

    while not screensaver_stop_event.is_set():
        items = get_media()
        if not items:
            time.sleep(10)
            continue

        candidates = [i for i in items if i["id"] != last_id] or items
        pick = random.choice(candidates)
        last_id = pick["id"]

        if OUTPUT_MODE == "ndi":
            try:
                proc = _launch_ndi_process(pick["path"], 0, f" (Screensaver: {pick['title']})")
            except FileNotFoundError:
                print(f"[screensaver] '{NDI_FFMPEG_BIN}' not found on PATH")
                return
        else:
            if os.path.exists(SCREENSAVER_SOCKET):
                os.remove(SCREENSAVER_SOCKET)
            cmd = [
                "mpv", "--fs", "--msg-level=all=error", "--osc=no", "--keep-open=no",
                f"--input-ipc-server={SCREENSAVER_SOCKET}",
            ]
            cmd.append("--mute=yes" if SCREENSAVER_MUTED else "--mute=no")
            if USE_DRM:
                cmd += ["--vo=gpu", "--gpu-context=drm"]
            cmd.append(pick["path"])
            try:
                proc = subprocess.Popen(cmd, env=_env_for_display())
            except FileNotFoundError:
                print("[screensaver] mpv not found on PATH")
                return

        with screensaver_lock:
            screensaver_process = proc

        while proc.poll() is None and not screensaver_stop_event.is_set():
            time.sleep(1)

        if screensaver_stop_event.is_set():
            if OUTPUT_MODE == "ndi":
                proc.terminate()
            else:
                _mpv_send({"command": ["quit"]}, SCREENSAVER_SOCKET)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            break
        # else: that pick finished naturally -> loop around to a new one

    with screensaver_lock:
        screensaver_process = None


# ------------------------------------------------------- mpv playback ---


def _watch_mpv_playback(generation, media_id, title, process, loop, item, retry_count=0):
    """Runs in a background thread for the lifetime of one mpv playback.
    Periodically records progress. On exit: if this was a deliberate stop
    (or a newer playback has already taken over), behaves as before. If it
    was supposed to be looping and just exited on its own — which shouldn't
    normally happen with --loop-file=inf, but has been observed with some
    very short clips — relaunch it automatically instead of silently
    leaving the UI stuck, with a small retry cap so a genuinely broken file
    doesn't spin the Pi in a fast crash loop.

    Polls quickly (every 0.5s) for the first few seconds specifically so a
    fast crash loop is detected and capped promptly, then settles into the
    coarser 5s cadence used for normal progress tracking once it's clearly
    running stably."""
    global mpv_stop_requested
    started_at = time.monotonic()
    last_pos, last_dur = None, None
    while process.poll() is None:
        elapsed = time.monotonic() - started_at
        if elapsed < 5:
            time.sleep(0.5)
            continue  # too early for position tracking to matter; just
                       # watching closely for a fast exit
        time.sleep(5)
        pos_r = _mpv_send({"command": ["get_property", "time-pos"]}, MPV_SOCKET)
        dur_r = _mpv_send({"command": ["get_property", "duration"]}, MPV_SOCKET)
        pos = pos_r.get("data") if pos_r else None
        dur = dur_r.get("data") if dur_r else None
        if pos is not None:
            last_pos, last_dur = pos, dur
            update_progress(media_id, title, pos, dur)

    ran_for = time.monotonic() - started_at
    was_intentional_stop = mpv_stop_requested
    mpv_stop_requested = False  # consume it — only applies to this exit

    if last_pos is not None:
        update_progress(media_id, title, last_pos, last_dur)

    if loop and not was_intentional_stop and generation == mpv_generation:
        if ran_for < 4 and retry_count >= 3:
            print(
                f"[mpv] '{title}' kept exiting within seconds of starting even "
                f"though it's set to loop (tried {retry_count} times) — giving "
                "up and falling back to the screensaver instead of retrying "
                "forever. Check `journalctl -u zealandata` for mpv's own error "
                "output around this point."
            )
        else:
            next_retry = retry_count + 1 if ran_for < 4 else 0
            print(f"[mpv] '{title}' exited unexpectedly while it should have "
                  f"been looping — relaunching (attempt {next_retry}).")
            _start_mpv_playback(item, resume_seconds=0, loop=loop, _retry_count=next_retry)
            return  # the relaunch spins up its own watcher; don't fall through

    # Only restart the screensaver if nothing newer has started meanwhile.
    if generation == mpv_generation:
        start_screensaver()


def _start_mpv_playback(match, resume_seconds, loop=None, _retry_count=0):
    global mpv_process, mpv_generation, mpv_stop_requested
    if loop is None:
        loop = LOOP_SELECTED_VIDEO
    with mpv_lock:
        if _mpv_is_running():
            mpv_stop_requested = True
            mpv_send({"command": ["quit"]})
            mpv_process.wait(timeout=5)
        if os.path.exists(MPV_SOCKET):
            os.remove(MPV_SOCKET)

        cmd = [
            "mpv", "--fs", "--hwdec=auto", f"--input-ipc-server={MPV_SOCKET}",
            "--osc=no", "--msg-level=all=error",
            # Default behavior: hold on the last frame when a video ends
            # (mpv pauses instead of exiting), rather than looping or
            # closing — keeps it scrubbable back and forth afterward.
            # --loop-file below overrides this when explicitly enabled.
            "--keep-open=yes",
        ]
        if USE_DRM:
            cmd += ["--vo=gpu", "--gpu-context=drm"]
        if loop:
            cmd.append("--loop-file=inf")
        if resume_seconds > 0:
            cmd.append(f"--start={resume_seconds}")
        cmd.append(match["path"])

        mpv_process = subprocess.Popen(cmd, env=_env_for_display())
        mpv_generation += 1
        gen = mpv_generation
        threading.Thread(
            target=_watch_mpv_playback,
            args=(gen, match["id"], match["title"], mpv_process, loop, match, _retry_count),
            daemon=True,
        ).start()


def set_output_mode(new_mode):
    """Live-switch between "hdmi" and "ndi". Stops whatever's currently
    playing (foreground video or screensaver) under the old mode, then
    starts the screensaver fresh under the new one, if enabled."""
    global OUTPUT_MODE, mpv_stop_requested
    if new_mode not in ("hdmi", "ndi"):
        raise ValueError("mode must be 'hdmi' or 'ndi'")
    with output_mode_lock:
        if new_mode == OUTPUT_MODE:
            return

        stop_screensaver()  # stop whichever-mode screensaver is running now

        if OUTPUT_MODE == "ndi":
            # Tear down without letting it restart the screensaver under the
            # OLD mode — we'll do that ourselves once the mode is flipped.
            _teardown_ndi_playback(restart_screensaver=False)
        elif _mpv_is_running():
            mpv_stop_requested = True
            mpv_send({"command": ["quit"]})
            try:
                mpv_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mpv_process.kill()

        OUTPUT_MODE = new_mode
        start_screensaver()


# --------------------------------------------------------------- routes ---


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/media")
def api_media():
    items = get_media()
    progress = get_all_progress()
    for item in items:
        p = progress.get(item["id"])
        item["progress"] = p
    return jsonify(items)


@app.route("/api/continue-watching")
def api_continue_watching():
    items_by_id = {i["id"]: i for i in get_media()}
    progress = get_all_progress()
    out = []
    for media_id, p in progress.items():
        item = items_by_id.get(media_id)
        if not item:
            continue  # file was removed/renamed
        out.append({**item, "progress": p})
    out.sort(key=lambda i: i["progress"]["updated"], reverse=True)
    return jsonify(out)


@app.route("/api/rescan", methods=["POST"])
def api_rescan():
    get_media(force=True)
    return api_media()


@app.route("/thumbnails/<path:filename>")
def thumbnails(filename):
    return send_from_directory(THUMB_DIR, filename)



@app.route("/api/output_mode", methods=["GET"])
def api_get_output_mode():
    return jsonify({
        "mode": OUTPUT_MODE,
        "switchable": SHOW_OUTPUT_TOGGLE,
        "ndi_binary_found": shutil.which(NDI_FFMPEG_BIN) is not None,
    })


@app.route("/api/output_mode", methods=["POST"])
def api_set_output_mode():
    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    if mode not in ("hdmi", "ndi"):
        return jsonify({"error": "mode must be 'hdmi' or 'ndi'"}), 400
    set_output_mode(mode)
    return jsonify({
        "mode": OUTPUT_MODE,
        "switchable": SHOW_OUTPUT_TOGGLE,
        "ndi_binary_found": shutil.which(NDI_FFMPEG_BIN) is not None,
    })


def _is_foreground_playing():
    """True if something's been explicitly selected and is playing/paused —
    as opposed to the screensaver's own ambient picks, which are tracked
    completely separately and don't count here."""
    if OUTPUT_MODE == "ndi":
        with ndi_lock:
            return ndi_state["media_id"] is not None
    return _mpv_is_running()


@app.route("/api/screensaver", methods=["GET"])
def api_get_screensaver():
    return jsonify({"enabled": SCREENSAVER_ENABLED})


@app.route("/api/screensaver", methods=["POST"])
def api_set_screensaver():
    global SCREENSAVER_ENABLED
    body = request.get_json(silent=True) or {}
    enabled = bool(body.get("enabled"))
    SCREENSAVER_ENABLED = enabled
    if not enabled:
        stop_screensaver()
    elif not _is_foreground_playing():
        # turn on and nothing's currently selected -> start it right away
        # rather than waiting for the next natural idle transition
        start_screensaver()
    return jsonify({"enabled": SCREENSAVER_ENABLED})


@app.route("/api/hero", methods=["GET"])
def api_get_hero():
    return jsonify({"id": get_hero_id()})


@app.route("/api/hero", methods=["POST"])
def api_set_hero():
    """Pin a specific item as the browse page's featured hero. Pass
    {"id": null} to clear it and go back to the automatic pick."""
    body = request.get_json(silent=True) or {}
    media_id = body.get("id")
    if media_id is not None and not get_media_by_id(media_id):
        return jsonify({"error": "not found"}), 404
    set_hero_id(media_id)
    return jsonify({"id": media_id})


@app.route("/api/play/<media_id>", methods=["POST"])
def api_play(media_id):
    _mark_interaction()
    match = get_media_by_id(media_id)
    if not match:
        return jsonify({"error": "not found"}), 404

    body = request.get_json(silent=True) or {}
    restart_from_beginning = bool(body.get("restart"))

    saved = None if restart_from_beginning else get_progress(media_id)
    resume_seconds = 0.0
    if saved and saved.get("duration") and RESUME_MIN_SECONDS <= saved["position"] < saved["duration"] * RESUME_MAX_FRACTION:
        resume_seconds = max(0, saved["position"] - 3)  # small rewind buffer
    elif restart_from_beginning:
        clear_progress(media_id)

    with meta_lock:
        current_media_meta.update({
            "id": match["id"], "title": match["title"],
            "description": match.get("description"),
            "is_sequence": match.get("is_sequence", False),
            "frame_count": match.get("frame_count"),
            "thumbnail": match.get("thumbnail"),
        })

    stop_screensaver()
    if OUTPUT_MODE == "ndi":
        start_ndi_playback(match, resume_seconds=resume_seconds)
    else:
        _start_mpv_playback(match, resume_seconds=resume_seconds)

    return jsonify({"status": "playing", "title": match["title"], "id": media_id, "output": OUTPUT_MODE})


@app.route("/api/control/<action>", methods=["POST"])
def api_control(action):
    _mark_interaction()

    if OUTPUT_MODE == "ndi":
        if action == "pause":
            return jsonify({"paused": ndi_control_pause()})
        if action == "stop":
            stop_ndi_playback()
            return jsonify({"result": "stopped"})
        if action == "seek_forward":
            ndi_control_seek(10)
            return jsonify({"result": "ok"})
        if action == "seek_backward":
            ndi_control_seek(-10)
            return jsonify({"result": "ok"})
        if action in ("volume_up", "volume_down", "frame_forward", "frame_backward"):
            return jsonify({"error": f"{action.replace('_', ' ')} isn't available in NDI output mode"}), 400
        return jsonify({"error": "unknown action"}), 400

    mapping = {
        "pause": {"command": ["cycle", "pause"]},
        "stop": {"command": ["quit"]},
        "seek_forward": {"command": ["seek", 10]},
        "seek_backward": {"command": ["seek", -10]},
        "volume_up": {"command": ["add", "volume", 5]},
        "volume_down": {"command": ["add", "volume", -5]},
        # mpv pauses automatically after stepping, which is exactly what you
        # want when inspecting a short sequence frame by frame.
        "frame_forward": {"command": ["frame-step"]},
        "frame_backward": {"command": ["frame-back-step"]},
    }
    if action not in mapping:
        return jsonify({"error": "unknown action"}), 400
    if action == "stop":
        global mpv_stop_requested
        mpv_stop_requested = True
    result = mpv_send(mapping[action])
    if action == "pause":
        # "cycle pause" doesn't report the resulting state, so read it back
        paused = mpv_send({"command": ["get_property", "pause"]})
        return jsonify({"result": result, "paused": paused.get("data") if paused else None})
    if action in ("frame_forward", "frame_backward"):
        # both leave mpv paused; report the resulting frame number so the
        # dock can show "Frame 3 of 5" immediately, without waiting a poll
        frame_r = mpv_send({"command": ["get_property", "estimated-frame-number"]})
        return jsonify({"result": result, "frame_number": frame_r.get("data") if frame_r else None})
    return jsonify({"result": result})


@app.route("/api/seek_to", methods=["POST"])
def api_seek_to():
    _mark_interaction()
    seconds = request.get_json(force=True).get("seconds")
    if seconds is None:
        return jsonify({"error": "seconds required"}), 400
    if OUTPUT_MODE == "ndi":
        ndi_control_seek_to(seconds)
        return jsonify({"result": "ok"})
    return jsonify({"result": mpv_send({"command": ["seek", seconds, "absolute"]})})


@app.route("/api/status")
def api_status():
    if OUTPUT_MODE == "ndi":
        with ndi_lock:
            if ndi_state["media_id"] is None:
                return jsonify({"playing": False, "output": "ndi"})
            with meta_lock:
                description = current_media_meta.get("description")
                title = current_media_meta.get("title") or ndi_state["title"]
                is_sequence = current_media_meta.get("is_sequence", False)
                frame_count = current_media_meta.get("frame_count")
                thumbnail = current_media_meta.get("thumbnail")
                media_id = current_media_meta.get("id")
            return jsonify({
                "playing": True,
                "position": _ndi_get_position(),
                "duration": ndi_state["duration"],
                "paused": ndi_state["paused"],
                "filename": ndi_state["title"],
                "id": media_id,
                "title": title,
                "description": description,
                "is_sequence": is_sequence,
                "frame_count": frame_count,
                "frame_number": None,  # frame stepping isn't available in NDI mode
                "thumbnail": thumbnail,
                "output": "ndi",
            })

    if not _mpv_is_running():
        return jsonify({"playing": False, "output": "hdmi"})

    def prop(name):
        r = mpv_send({"command": ["get_property", name]})
        return r.get("data") if r else None

    with meta_lock:
        description = current_media_meta.get("description")
        title = current_media_meta.get("title")
        is_sequence = current_media_meta.get("is_sequence", False)
        frame_count = current_media_meta.get("frame_count")
        thumbnail = current_media_meta.get("thumbnail")
        media_id = current_media_meta.get("id")

    return jsonify(
        {
            "playing": True,
            "position": prop("time-pos"),
            "duration": prop("duration"),
            "paused": prop("pause"),
            "id": media_id,
            "filename": prop("filename"),
            "title": title,
            "description": description,
            "is_sequence": is_sequence,
            "frame_count": frame_count,
            "thumbnail": thumbnail,
            # only worth the extra IPC round-trip for sequences, where the
            # dock actually shows a frame counter
            "frame_number": prop("estimated-frame-number") if is_sequence else None,
            "output": "hdmi",
        }
    )


if __name__ == "__main__":
    start_screensaver()
    threading.Thread(target=_idle_watcher_loop, daemon=True).start()
    port = int(os.environ.get("ZEALANDATA_PORT", "8000"))
    app.run(host="0.0.0.0", port=port, threaded=True)
