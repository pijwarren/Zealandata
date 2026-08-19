"""
Zealandata server
=============
Serves a Netflix/Apple-TV style browsing UI over the local network.
Video playback does NOT happen in the browser — it happens on the Pi
itself, via a single long-lived mpv process that owns the HDMI output for
the entire life of the service. Everything it shows — the idle/loading
image, a selected video, a screensaver pick — is switched by sending it
`loadfile` over its IPC socket rather than starting and stopping separate
mpv processes. On headless DRM/KMS output (no window manager), a process
handoff is the only thing that can let the Linux console underneath flash
into view, so avoiding that handoff entirely is what keeps it hidden.

When nothing's been chosen, an optional screensaver mode cycles through
random videos from the library, muted by default, until someone picks
something from the web UI.

Media can also come from image sequences: any leaf folder containing a run
of numbered images (frame_0001.png, frame_0002.png, ...) is automatically
converted to a video once (cached) and treated exactly like any other file.

Run with:  python3 server.py
Config via environment variables (see README.md).
"""

import os
import json
import socket
import subprocess
import threading
import time
import random
import hashlib
import shutil
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, send_file, render_template
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------- config ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.environ.get("ZEALANDATA_MEDIA_DIR", "/home/pi/media")
THUMB_DIR = os.path.join(BASE_DIR, "static", "thumbnails")
HERO_THUMB_DIR = os.path.join(BASE_DIR, "static", "hero_thumbnails")
SEQUENCE_CACHE_DIR = os.path.join(BASE_DIR, "static", "sequence_cache")
PROGRESS_FILE = os.path.join(BASE_DIR, "progress.json")
HERO_FILE = os.path.join(BASE_DIR, "hero.json")
TITLES_FILE = os.path.join(BASE_DIR, "titles.json")
PLAY_COUNTS_FILE = os.path.join(BASE_DIR, "play_counts.json")

MPV_SOCKET = "/tmp/zealandata-mpv.sock"

# DISPLAY only matters if the Pi is running a desktop (X11) session.
# Ignored entirely when using headless DRM output (see README).
X_DISPLAY = os.environ.get("ZEALANDATA_DISPLAY", ":0")
USE_DRM = os.environ.get("ZEALANDATA_USE_DRM", "0") == "1"

# Which thing actually owns the HDMI output: "mpv" (default) drives a
# persistent mpv process exactly as described above. "webgl" instead points
# a fullscreen Chromium kiosk at this server's own /projection page, which
# renders the same video content texture-mapped onto a 3D model (see
# PROJECTION_OBJ_PATH) for physical projection-mapping setups, with its pose
# (scale/rotation/offset) calibrated via /api/mapping. All the higher-level
# orchestration (screensaver shuffling, spinner transitions, idle timeout,
# progress tracking) is shared between both backends -- only the low-level
# "load this file" / "get playback position" / "pause, seek, stop" primitives
# differ, behind the backend_* functions below.
RENDER_BACKEND = os.environ.get("ZEALANDATA_RENDER_BACKEND", "mpv").strip().lower()
PROJECTION_OBJ_PATH = os.environ.get(
    "ZEALANDATA_PROJECTION_OBJ", os.path.join(BASE_DIR, "static", "projection_model.obj")
)
MAPPING_FILE = os.path.join(BASE_DIR, "mapping.json")
MAPPING_NUMERIC = {
    "scale": 1.0,
    # Independent Euler rotation in degrees around each axis, applied in
    # x/y/z order -- not just a single "yaw" around the model's detected
    # up-axis -- since correcting for a projector that isn't perfectly
    # perpendicular to the model needs tilt/roll too, not just spin.
    "rotation_x": 0.0,
    "rotation_y": 0.0,
    "rotation_z": 0.0,
    "offset_x": 0.0,
    "offset_y": 0.0,
}
# Calibration aid only: lights the model from an angle so its relief is
# actually readable while lining it up. Deliberately off by default and
# never left on for real projection -- shading the video with fake light
# fights the physical object's own real shading, which is the whole point
# of projecting onto it.
MAPPING_BOOLEAN = {"shading": False}
DEFAULT_MAPPING = {**MAPPING_NUMERIC, **MAPPING_BOOLEAN}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts"}

# Image sequences: a leaf folder containing this many (or more) images, all
# the same format, and nothing else but an optional description.txt, gets
# converted to a video once and cached under SEQUENCE_CACHE_DIR.
SEQUENCE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
SEQUENCE_MIN_FRAMES = int(os.environ.get("ZEALANDATA_SEQUENCE_MIN_FRAMES", "3"))
SEQUENCE_FPS = float(os.environ.get("ZEALANDATA_SEQUENCE_FPS", "12"))

# Supplementary documents (e.g. a scientific paper PDF, reference images)
# shown alongside a video in the web UI while it plays. For a plain video
# file, e.g. nova.mp4, they (and its description.txt) live in a dedicated
# nova.attachments/ sibling folder, keeping the category folder itself down
# to just one entry per video instead of a pile of loose sidecar files. For
# an image-sequence folder, attachments instead live in an attachments/
# subfolder inside it (since the folder itself is already dedicated to that
# one item).
ATTACHMENT_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
ATTACHMENTS_DIR_SUFFIX = ".attachments"

# Screensaver: when nothing's been chosen, shuffle through random videos
# from the library itself.
SCREENSAVER_ENABLED = os.environ.get("ZEALANDATA_SCREENSAVER_ENABLED", "1") == "1"
SCREENSAVER_MUTED = os.environ.get("ZEALANDATA_SCREENSAVER_MUTED", "1") == "1"

# Play-count tracking (drives the "Most Popular" row): off by default and
# deliberately not env-configurable at startup -- always starts off after a
# restart, only ever turned on at runtime via the admin-gated
# /api/play-tracking endpoint, so idle testing/browsing doesn't pollute the
# counts unless someone in admin mode explicitly opts in for that session.
PLAY_TRACKING_ENABLED = False

# Whether the "Most Popular" row is actually shown to viewers, independent
# of whether counts are being tracked -- lets an admin accumulate/curate
# data with tracking on while keeping the row itself hidden from regular
# browsing until they're ready to reveal it. Same off-by-default,
# admin-gated-only-toggle reasoning as PLAY_TRACKING_ENABLED above.
POPULAR_ROW_VISIBLE = False

# Default behavior when a selected video reaches the end: mpv pauses on the
# last frame (see keep-open=yes below), so it can be scrubbed back and
# forth rather than the screensaver kicking back in automatically. Set this
# to loop the video indefinitely instead — screensaver picks are never
# looped individually either way, only a deliberate selection. This is
# just the startup default; the loop button in the dock flips a global
# loop_enabled (below), which -- unlike this constant -- carries forward
# into whatever gets selected next, rather than resetting every time.
LOOP_SELECTED_VIDEO = os.environ.get("ZEALANDATA_LOOP_SELECTED", "0") == "1"

# If something's left PAUSED (not stopped) for this long with no further
# interaction, automatically stop it and fall back to the screensaver.
# Doesn't affect actively-playing/looping video — only abandoned pauses.
# Also reused as the one-time boot-grace delay before the screensaver
# takes over after a fresh start/restart (see _boot_grace_then_screensaver)
# -- same "how long is quiet before something automatic kicks in" idea, so
# this is really the screensaver's default timeout in both places it applies.
IDLE_TIMEOUT_ENABLED = os.environ.get("ZEALANDATA_IDLE_TIMEOUT_ENABLED", "0") == "1"
IDLE_TIMEOUT_SECONDS = float(os.environ.get("ZEALANDATA_IDLE_TIMEOUT_SECONDS", "600"))

# Optional: a static image shown whenever there's genuinely nothing else
# queued (server just started, playback was explicitly stopped, or the
# screensaver is off) — held indefinitely rather than leaving the Linux
# console underneath as the last thing on screen. No-op if unset.
LOADING_IMAGE_PATH = os.environ.get("ZEALANDATA_LOADING_IMAGE", "").strip() or None

# Optional: a 4-digit PIN that gates "admin mode" in the web UI (currently
# just renaming videos). Unset by default -- the admin-mode UI and its
# endpoints are simply unavailable until you set one.
ADMIN_PIN = os.environ.get("ZEALANDATA_ADMIN_PIN", "").strip() or None
ADMIN_MAX_ATTEMPTS = 5
ADMIN_LOCKOUT_SECONDS = 120
UPLOAD_MAX_MB = int(os.environ.get("ZEALANDATA_UPLOAD_MAX_MB", "8192"))

# A short spinner animation is shown between every HDMI transition (a
# selected video, a screensaver pick, the idle image) rather than a
# brightness-based cross-fade -- see SPINNER_VIDEO_PATH/_hdmi_load. Held for
# this long before the real content loads.
SPINNER_HOLD_SECONDS = 1.5
SPINNER_VIDEO_PATH = os.path.join(BASE_DIR, "static", "spinner.mp4")

# Resume threshold: only offer/apply "continue watching" if between these
# fractions of the way through (avoids resuming a 3-second stub, and avoids
# "resuming" something that's basically already finished).
RESUME_MIN_SECONDS = 10
RESUME_MAX_FRACTION = 0.95

os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(HERO_THUMB_DIR, exist_ok=True)
os.makedirs(SEQUENCE_CACHE_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = UPLOAD_MAX_MB * 1024 * 1024

mpv_process = None
mpv_binary_missing = False  # set once if mpv isn't on PATH at all -- stops
                             # _hdmi_supervisor_loop from retrying every 2s
                             # forever on a machine that will never have it
mpv_lock = threading.Lock()
mpv_generation = 0  # bumped every time ownership of the persistent mpv
                     # process changes hands (idle / a selected video /
                     # a screensaver session) — lets a stale watcher or
                     # screensaver loop recognize it's been superseded

current_kind = "idle"  # "idle" | "video" | "screensaver" — whatever the
                        # persistent mpv process is currently showing

loop_enabled = LOOP_SELECTED_VIDEO  # global toggle (dock loop button) --
                                     # applied to every subsequent
                                     # selection until switched off again,
                                     # not just the video it was set on

screensaver_thread = None
screensaver_stop_event = threading.Event()

# Metadata for whatever's currently playing — mainly so /api/status can
# report a description without mpv needing to know what one is.
meta_lock = threading.Lock()
current_media_meta = {"id": None, "title": None, "description": None, "is_sequence": False, "frame_count": None, "thumbnail": None}

# Title of whatever the screensaver is currently showing -- separate from
# current_media_meta above, which is only for a deliberate selection, so the
# dock can display "Screensaver mode: <title>" instead of "Nothing playing".
screensaver_meta_lock = threading.Lock()
current_screensaver_title = None

# Last time any playback-control endpoint was hit — drives the idle timeout.
_interaction_lock = threading.Lock()
_last_interaction = time.monotonic()

_media_cache = {"items": None, "mtime": 0}
_media_attachments = {}  # media_id -> {filename: absolute path}, rebuilt on every scan

progress_lock = threading.Lock()
hero_lock = threading.Lock()
titles_lock = threading.Lock()
play_counts_lock = threading.Lock()
mapping_lock = threading.Lock()

# ---------------------------------------------------------- webgl backend ---
# Only meaningful when RENDER_BACKEND == "webgl". There's no persistent mpv
# process to hold state for us, so the /projection page reports its own
# playback position/state back via /api/projection/heartbeat, and this
# dict is what backend_get() reads from. projection_state is the other
# direction -- what the page should currently be showing/doing, polled via
# /api/projection/state. Together these two dicts play the same role mpv's
# IPC socket does for the mpv backend: one for "tell it what to do", one for
# "ask it what's happening".
projection_lock = threading.Lock()
projection_state = {
    "load_seq": 0,       # bumped every time "path" changes -- lets the page
                          # tell a fresh load apart from a same-value poll
    "path": None,         # stream URL for the page's <video>, or None
    "is_image": False,    # True => show a plain <img> overlay, not the 3D scene
    "keep_open": "yes",   # mirrors mpv's keep-open: "yes" = pause on last
                           # frame when finished, "no" = report idle-active
    "loop": False,
    "mute": False,
    "start": 0.0,          # seconds to seek to right after loading
    "fps": SEQUENCE_FPS,
    "command": None,       # one-shot control command, see backend_control()
    "command_seq": 0,
}
projection_report = {
    "load_seq": None,      # last load_seq this report reflects
    "position": None, "duration": None, "paused": None,
    "idle_active": None, "looping": None, "frame_number": None,
    "ack_seq": 0,
    "renderer_fps": None,  # diagnostic only -- see /api/projection/stats
}


def get_mapping():
    if not os.path.exists(MAPPING_FILE):
        return dict(DEFAULT_MAPPING)
    try:
        with open(MAPPING_FILE, "r") as f:
            data = json.load(f)
        return {**DEFAULT_MAPPING, **{k: data[k] for k in DEFAULT_MAPPING if k in data}}
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_MAPPING)


def set_mapping(values):
    with mapping_lock:
        merged = {**get_mapping(), **values}
        tmp = MAPPING_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(merged, f)
        os.replace(tmp, MAPPING_FILE)
        return merged


def backend_get(name):
    """Returns the raw value (not mpv's {"data": ...} wrapper) for one of a
    small set of playback properties, from whichever backend is active."""
    if RENDER_BACKEND != "webgl":
        r = mpv_send({"command": ["get_property", name]})
        return r.get("data") if r else None
    with projection_lock:
        rep = dict(projection_report)
    return {
        "idle-active": rep.get("idle_active"),
        "time-pos": rep.get("position"),
        "duration": rep.get("duration"),
        "pause": rep.get("paused"),
        "loop-file": rep.get("looping"),
        "estimated-frame-number": rep.get("frame_number"),
        "filename": None,
    }.get(name)


def backend_control(action, value=None, wait=True, timeout=1.5):
    """Issues a control action ("toggle_pause", "stop", "seek",
    "frame_step", "frame_back_step", "toggle_loop") to whichever backend is
    active. For mpv this is a direct IPC command. For webgl this posts a
    one-shot command for the /projection page to pick up on its next poll
    and, if wait=True, blocks (briefly) until that page's next heartbeat
    acknowledges it -- mirroring mpv_send's own synchronous request/reply
    IPC call, just over HTTP polling instead of a socket."""
    if RENDER_BACKEND != "webgl":
        mpv_mapping = {
            "toggle_pause": {"command": ["cycle", "pause"]},
            "stop": {"command": ["stop"]},
            "seek": {"command": ["seek", value, "absolute"]},
            "frame_step": {"command": ["frame-step"]},
            "frame_back_step": {"command": ["frame-back-step"]},
            "toggle_loop": {"command": ["cycle-values", "loop-file", "inf", "no"]},
        }
        return mpv_send(mpv_mapping[action])

    with projection_lock:
        projection_state["command_seq"] += 1
        seq = projection_state["command_seq"]
        projection_state["command"] = {"seq": seq, "action": action, "value": value}
    if not wait:
        return None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with projection_lock:
            if projection_report.get("ack_seq") == seq:
                return dict(projection_report)
        time.sleep(0.05)
    return None


def backend_stop():
    backend_control("stop", wait=False)

# PIN brute-force lockout: per-client-IP wrong-attempt counts and lockout
# expiry, checked by every admin-gated endpoint (see check_admin_pin).
admin_lock = threading.Lock()
admin_attempts = {}  # ip -> {"count": int, "locked_until": monotonic() or None}

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


# --------------------------------------------------------- play counts ---


def _load_play_counts():
    if not os.path.exists(PLAY_COUNTS_FILE):
        return {}
    try:
        with open(PLAY_COUNTS_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_play_counts_store(store):
    tmp = PLAY_COUNTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(store, f)
    os.replace(tmp, PLAY_COUNTS_FILE)


def get_all_play_counts():
    with play_counts_lock:
        return _load_play_counts()


def increment_play_count(media_id):
    with play_counts_lock:
        store = _load_play_counts()
        store[media_id] = store.get(media_id, 0) + 1
        _save_play_counts_store(store)


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


def hero_thumbnail_url(media_id):
    """The full-res hero banner image for this item, generated on demand
    the first time it's needed (see ensure_hero_thumbnail) — None if it
    hasn't been (yet)."""
    path = os.path.join(HERO_THUMB_DIR, f"{media_id}.jpg")
    return f"/hero_thumbnails/{media_id}.jpg" if os.path.exists(path) else None


def _load_titles():
    if not os.path.exists(TITLES_FILE):
        return {}
    try:
        with open(TITLES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def get_title_override(media_id):
    """A custom display title set via admin-mode renaming, if any — the
    underlying file itself is never touched, so this survives rescans and
    doesn't disturb thumbnail/progress/hero caches, which are all keyed off
    the original file path."""
    with titles_lock:
        return _load_titles().get(media_id)


def set_title_override(media_id, title):
    with titles_lock:
        store = _load_titles()
        store[media_id] = title
        tmp = TITLES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(store, f)
        os.replace(tmp, TITLES_FILE)


# ------------------------------------------------------------- scanning ---


def _probe_duration(path):
    """Read a file's duration via ffprobe, to enrich items generally."""
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
    """A folder qualifies as an image sequence if it has no subfolders
    (other than a reserved attachments/ one, see _find_attachment_paths),
    at least SEQUENCE_MIN_FRAMES images all of the same extension, and
    nothing else besides those images and (optionally) a description.txt.
    Returns the sorted list of frame filenames, or None if it doesn't
    qualify."""
    try:
        entries = os.listdir(dir_path)
    except OSError:
        return None

    if any(
        os.path.isdir(os.path.join(dir_path, e)) and e.lower() != "attachments"
        for e in entries
    ):
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


def _video_attachment_dir(video_path):
    return os.path.splitext(video_path)[0] + ATTACHMENTS_DIR_SUFFIX


def _find_attachment_paths(metadata_path):
    """metadata_path is a sequence folder (attachments live in an
    attachments/ subfolder inside it) or a plain video file (attachments
    live in a <stem>.attachments/ sibling folder -- see
    _migrate_video_sidecars, which is what actually gets files there)."""
    if os.path.isdir(metadata_path):
        attach_dir = os.path.join(metadata_path, "attachments")
    else:
        attach_dir = _video_attachment_dir(metadata_path)
    if not os.path.isdir(attach_dir):
        return []
    try:
        names = sorted(os.listdir(attach_dir))
    except OSError:
        return []
    return [os.path.join(attach_dir, n) for n in names if Path(n).suffix.lower() in ATTACHMENT_EXTS]


def _legacy_sidecar_paths(video_path):
    """Attachment files under the pre-cleanup convention: loose in the same
    folder as the video, named exactly like it or prefixed with its stem
    (nova.pdf, nova_fig1.jpg, ...). Only used by _migrate_video_sidecars to
    find things to move into the new nova.attachments/ folder -- once
    migrated, _find_attachment_paths is what's actually read from."""
    dir_path = os.path.dirname(video_path)
    stem = Path(video_path).stem
    try:
        names = sorted(os.listdir(dir_path))
    except OSError:
        return []
    matches = []
    for name in names:
        full = os.path.join(dir_path, name)
        if full == video_path or not os.path.isfile(full):
            continue
        if Path(name).suffix.lower() not in ATTACHMENT_EXTS:
            continue
        other_stem = Path(name).stem
        if other_stem == stem or other_stem.startswith(stem + "_") or other_stem.startswith(stem + "-") or other_stem.startswith(stem + "."):
            matches.append(full)
    return matches


def _migrate_video_sidecars(video_path):
    """One-time cleanup, re-checked (cheaply) on every scan: moves a
    video's loose description.txt and sidecar files out of the shared
    category folder and into its own <stem>.attachments/ folder, so a
    folder of N videos doesn't end up with N*(1 + attachments) loose files
    sitting side by side. No-op once already migrated."""
    dir_path = os.path.dirname(video_path)
    stem = Path(video_path).stem
    old_desc = os.path.join(dir_path, stem + ".txt")
    has_desc = os.path.isfile(old_desc)
    legacy_files = _legacy_sidecar_paths(video_path)
    if not has_desc and not legacy_files:
        return

    attach_dir = _video_attachment_dir(video_path)
    os.makedirs(attach_dir, exist_ok=True)
    moved = 0
    if has_desc:
        dest = os.path.join(attach_dir, "description.txt")
        if not os.path.exists(dest):
            shutil.move(old_desc, dest)
            moved += 1
    for src in legacy_files:
        dest = os.path.join(attach_dir, os.path.basename(src))
        if not os.path.exists(dest):
            shutil.move(src, dest)
            moved += 1
    if moved:
        print(f"[sidecar] moved {moved} file(s) for '{stem}' into {attach_dir}")


def _build_media_item(playback_path, metadata_path, description=None, frame_count=None):
    """playback_path is what mpv actually opens; metadata_path is what the
    id/title/category get derived from (same as playback_path for a plain
    video file; the original frames folder for a converted image sequence,
    so its identity survives a cache rebuild). frame_count is set only for
    converted image sequences — it's what lets the UI show frame-by-frame
    stepping controls instead of (or alongside) the normal ±10s seek
    buttons for short sequences where seconds aren't meaningful."""
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

    title = get_title_override(media_id) or Path(metadata_path).stem.replace(".", " ").replace("_", " ")

    attachments = []
    attachment_files = {}
    for full in _find_attachment_paths(metadata_path):
        name = os.path.basename(full)
        kind = "pdf" if Path(name).suffix.lower() == ".pdf" else "image"
        attachments.append({"name": name, "kind": kind, "url": f"/api/media/{media_id}/attachments/{name}"})
        attachment_files[name] = full
    _media_attachments[media_id] = attachment_files

    return {
        "id": media_id,
        "title": title,
        "path": playback_path,
        "category": category,
        "duration": _probe_duration(playback_path),
        "description": description,
        "is_sequence": frame_count is not None,
        "frame_count": frame_count,
        "thumbnail": f"/thumbnails/{media_id}.jpg" if os.path.exists(thumb_path) else None,
        "attachments": attachments,
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
            # "attachments" is reserved for a sequence's own supplementary
            # docs/images, and anything.attachments/ for a plain video's
            # (see _find_attachment_paths) -- neither is itself a category
            # or a sequence to scan into, even though the latter might hold
            # >= SEQUENCE_MIN_FRAMES images of the same format.
            if name.lower() == "attachments" or name.lower().endswith(ATTACHMENTS_DIR_SUFFIX):
                continue
            _scan_dir(full, items)
        else:
            ext = Path(name).suffix.lower()
            if ext in VIDEO_EXTS:
                _migrate_video_sidecars(full)
                description = _read_text_file(os.path.join(_video_attachment_dir(full), "description.txt"))
                items.append(_build_media_item(full, full, description=description))


def _scan_media():
    items = []
    _media_attachments.clear()
    _scan_dir(MEDIA_DIR, items, is_root=True)
    items.sort(key=lambda i: i["title"].lower())
    return items


def get_media(force=False):
    if force or _media_cache["items"] is None:
        _media_cache["items"] = _scan_media()
    return _media_cache["items"]


def get_media_by_id(media_id):
    return next((i for i in get_media() if i["id"] == media_id), None)


def _extract_frame(video_path, out_path, scale_expr):
    """Grab a frame partway into the file. Uses the actual duration to pick
    a sensible timestamp rather than hardcoded absolute times — a fixed "1
    minute in, then 2 seconds in" fallback (the previous approach) silently
    produces no thumbnail at all for anything shorter than 2 seconds, which
    is common for short test clips and some very brief image-sequence
    exports."""
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
                    "-frames:v", "1", "-vf", f"scale={scale_expr}", out_path,
                ],
                capture_output=True, timeout=30,
            )
        except Exception as exc:
            print(f"[thumbnail] failed for {video_path}: {exc}")
            return False
        if os.path.exists(out_path):
            return True

    print(f"[thumbnail] no frame could be extracted for {video_path} "
          f"(duration={duration}) — is it a valid, playable video file?")
    return False


def _generate_thumbnail(video_path, thumb_path):
    """Poster-grid size — small, since dozens of these are visible at once."""
    _extract_frame(video_path, thumb_path, "440:-1")


def _generate_hero_thumbnail(video_path, thumb_path):
    """Full-bleed banner size — much larger than the poster thumbnail, since
    it's stretched across the whole width of the browse page. Capped at the
    source's own width so a small source doesn't get visibly upscaled."""
    _extract_frame(video_path, thumb_path, "'min(1920,iw)':-2")


def ensure_hero_thumbnail(media_id, video_path):
    """Generates the full-res hero banner image for this item the first
    time it's needed -- either pinned as hero (api_set_hero) or previewed
    by selecting a poster in the browse grid (api_media_preview) -- and
    reuses the cached file every time after. Returns the URL, or None if
    generation genuinely failed (e.g. an unreadable file)."""
    thumb_path = os.path.join(HERO_THUMB_DIR, f"{media_id}.jpg")
    if not os.path.exists(thumb_path):
        _generate_hero_thumbnail(video_path, thumb_path)
    return hero_thumbnail_url(media_id)


# ------------------------------------------------------------- mpv IPC ---


def mpv_send(command):
    if not hasattr(socket, "AF_UNIX"):
        # Windows without AF_UNIX support (older Windows builds, or Python
        # built without it) -- there's no mpv IPC to speak of here anyway,
        # so degrade the same way a missing mpv binary already does rather
        # than crashing every play/control/status call. Lets the rest of
        # the web UI (browsing, admin, uploads) run fine on any machine for
        # testing, even with no real playback backing it.
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(MPV_SOCKET)
            s.sendall((json.dumps(command) + "\n").encode())
            resp = s.recv(4096)
    except (FileNotFoundError, ConnectionRefusedError, OSError, socket.timeout):
        return None
    if not resp:
        return None
    # mpv can push an unsolicited event notification on the same connection
    # right after a command's own reply -- the reply itself is always the
    # first line, so parse just that rather than the whole (possibly
    # multi-line) buffer.
    try:
        return json.loads(resp.split(b"\n", 1)[0].decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def _mpv_is_running():
    return mpv_process is not None and mpv_process.poll() is None


def _env_for_display():
    env = os.environ.copy()
    if not USE_DRM:
        env.setdefault("DISPLAY", X_DISPLAY)
    return env


def _wait_for_socket(path, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.05)
    return False


def _spawn_hdmi_process():
    """(Re)start the single mpv instance that owns HDMI output for the life
    of the service. Everything after this — the idle image, a selected
    video, a screensaver pick — is switched by loadfile-ing over its IPC
    socket rather than starting/stopping separate processes, so DRM master
    is acquired once here and never released. That's what actually stops
    the Linux console from ever flashing through: a real process handoff
    always risks it for a frame or two, no matter how tightly it's
    sequenced. If a loading image is configured, it's passed as the
    startup file directly (the normal, best-tested mpv codepath) rather
    than relying on an idle black window."""
    global mpv_process, mpv_binary_missing
    if os.path.exists(MPV_SOCKET):
        os.remove(MPV_SOCKET)
    cmd = [
        "mpv", "--fs", "--force-window=yes", "--idle=yes", "--hwdec=auto",
        f"--input-ipc-server={MPV_SOCKET}", "--osc=no", "--msg-level=all=error",
        "--keep-open=yes",
    ]
    if USE_DRM:
        cmd += ["--vo=gpu", "--gpu-context=drm"]
    if LOADING_IMAGE_PATH and os.path.exists(LOADING_IMAGE_PATH):
        cmd += ["--image-display-duration=inf", "--no-audio", LOADING_IMAGE_PATH]
    try:
        mpv_process = subprocess.Popen(cmd, env=_env_for_display())
    except FileNotFoundError:
        if not mpv_binary_missing:
            print("[mpv] 'mpv' not found on PATH — HDMI playback won't work")
        mpv_binary_missing = True
        mpv_process = None
        return
    _wait_for_socket(MPV_SOCKET)


def _hdmi_supervisor_loop():
    """Runs for the life of the process. Normal transitions never touch the
    persistent mpv process itself, only its IPC socket, so this only fires
    if mpv genuinely crashes — rare, but worth recovering from rather than
    leaving the console exposed indefinitely."""
    global mpv_generation
    while True:
        time.sleep(2)
        with mpv_lock:
            if _mpv_is_running() or mpv_binary_missing:
                continue
            print("[mpv] persistent HDMI process died — restarting")
            _spawn_hdmi_process()
            mpv_generation += 1
        _enter_idle_state(spinner=False)


def _still_current(gen):
    """True if gen (an mpv_generation snapshot) is still the active one, or
    None was passed (meaning "not tracking a generation, always proceed").
    Read without mpv_lock -- same as the other generation checks in this
    file; it's a bare int comparison, and the whole point is for a stale
    load to notice it's been superseded and bail immediately rather than
    running to completion first (see _hdmi_load)."""
    return gen is None or gen == mpv_generation


def _claim_generation(kind):
    """Bump mpv_generation and set current_kind, atomically, and hand back
    the new generation number -- the one thing that actually needs the
    lock. Everything after this (the spinner, the loadfile) runs lock-free,
    so a competing claim can supersede it immediately instead of having to
    wait for it to finish first."""
    global mpv_generation, current_kind
    with mpv_lock:
        current_kind = kind
        mpv_generation += 1
        return mpv_generation


def _backend_set_props_and_load(path, keep_open, loop_file, mute, start, image_duration=None, media_id=None, is_image=False):
    """The one place that actually pushes a file onto whichever backend
    owns HDMI output -- everything above this (spinner timing, generation
    checks) is shared between both backends."""
    if RENDER_BACKEND != "webgl":
        if image_duration is not None:
            mpv_send({"command": ["set_property", "image-display-duration", image_duration]})
        mpv_send({"command": ["set_property", "keep-open", keep_open]})
        mpv_send({"command": ["set_property", "loop-file", loop_file]})
        mpv_send({"command": ["set_property", "mute", mute]})
        mpv_send({"command": ["set_property", "start", start]})
        mpv_send({"command": ["set_property", "pause", "no"]})
        mpv_send({"command": ["loadfile", path, "replace"]})
        return

    # webgl backend: translate an mpv-style absolute filesystem path into a
    # URL the /projection page's <video> can actually load. media_id (when
    # the caller has one -- a real library item) is the normal case; the
    # spinner and idle image are the two fixed exceptions.
    if media_id:
        url = f"/api/media/{media_id}/stream"
    elif path == SPINNER_VIDEO_PATH:
        url = "/static/spinner.mp4"
    elif path == LOADING_IMAGE_PATH:
        url = "/api/loading-image"
    else:
        url = None
    try:
        start_seconds = 0.0 if start in ("none", None) else float(start)
    except (TypeError, ValueError):
        start_seconds = 0.0
    with projection_lock:
        projection_state.update({
            "load_seq": projection_state["load_seq"] + 1,
            "path": url,
            "is_image": is_image,
            "keep_open": keep_open,
            "loop": loop_file not in (None, False, "no"),
            "mute": mute == "yes",
            "start": start_seconds,
        })


def _hdmi_load(path, keep_open, loop_file, mute, start="none", image_duration=None, spinner=True, gen=None, media_id=None, is_image=False):
    """Set the playback properties that should apply to the next file, then
    load it. Done as separate set_property calls (rather than loadfile's
    own trailing "options" argument) since that argument's exact position
    varies across mpv versions and isn't worth chasing down per-build.
    "pause" is reset explicitly too -- unlike the others, it's not a
    per-file property, so pausing one video and then stopping it would
    otherwise leave the *next* thing loaded (a screensaver pick, another
    video) starting paused as well.

    spinner=True briefly cuts to a short spinner animation (an ordinary
    video, played via the same loadfile mechanism as everything else)
    before loading the real content -- a cross-fade (an earlier approach)
    needed mpv's "brightness" equalizer property animated via a rapid
    sequence of IPC calls, which turned out to be fragile on real hardware
    and produced a visibly choppy ramp; this needs nothing exotic at all.
    spinner=False skips it entirely -- used only for the very first
    idle-image load right after mpv is spawned, since touching mpv that
    early risks it before its DRM context has actually settled.

    gen, if given, is checked before the spinner, after its hold, and
    before the real loadfile -- if something newer has already claimed the
    generation by any of those points, this bails out immediately rather
    than finishing a transition that's about to be immediately overwritten
    (e.g. someone picked a video while a screensaver pick's spinner was
    still showing).

    media_id/is_image are only meaningful for the webgl backend -- see
    _backend_set_props_and_load."""
    if not _still_current(gen):
        return
    if spinner and os.path.exists(SPINNER_VIDEO_PATH):
        _backend_set_props_and_load(SPINNER_VIDEO_PATH, keep_open="no", loop_file="inf", mute="yes", start="none")
        time.sleep(SPINNER_HOLD_SECONDS)
        if not _still_current(gen):
            return
    _backend_set_props_and_load(path, keep_open, loop_file, mute, start, image_duration=image_duration, media_id=media_id, is_image=is_image)


def _go_idle(spinner=True, gen=None):
    """Show the loading image, held indefinitely, if one's configured;
    otherwise just unload whatever was playing and sit on mpv's own idle
    black frame."""
    global current_kind
    current_kind = "idle"
    if LOADING_IMAGE_PATH and os.path.exists(LOADING_IMAGE_PATH):
        _hdmi_load(LOADING_IMAGE_PATH, keep_open="yes", loop_file="no",
                   mute="yes", image_duration="inf", spinner=spinner, gen=gen, is_image=True)
    else:
        backend_stop()


def _enter_idle_state(spinner=True):
    """Called whenever HDMI has nothing queued next. Prefers the
    screensaver when it's enabled; otherwise holds the idle image so the
    console is never what ends up on screen. spinner=False is passed
    through right after a fresh mpv spawn (startup, or a crash-restart) so
    the very first load doesn't touch mpv before its DRM context has
    settled."""
    if SCREENSAVER_ENABLED:
        start_screensaver(spinner=spinner)
    else:
        gen = _claim_generation("idle")
        _go_idle(spinner=spinner, gen=gen)


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
        if current_kind == "video":
            if backend_get("pause"):
                backend_stop()
                _mark_interaction()


def _boot_grace_then_screensaver():
    """On startup (a cold boot or a service restart), hold the idle image
    for IDLE_TIMEOUT_SECONDS before letting the screensaver take over,
    rather than jumping straight into shuffling videos the instant the
    process comes up -- e.g. a restart mid-event shouldn't immediately
    start playing something unrelated. Reuses IDLE_TIMEOUT_SECONDS rather
    than a separate setting since it's the same "how long is quiet before
    something automatic kicks in" idea. Only a one-time startup delay —
    every other idle transition (a stop, a pause timeout) still brings the
    screensaver back immediately, same as before."""
    time.sleep(IDLE_TIMEOUT_SECONDS)
    if current_kind == "idle":
        start_screensaver()


# --------------------------------------------------------- screensaver ---


def start_screensaver(spinner=True):
    """Kick off a background thread that shuffles through random library
    videos, one after another, until stop_screensaver() is called (i.e.
    someone picks something to watch)."""
    global screensaver_thread, current_kind, mpv_generation
    if not SCREENSAVER_ENABLED:
        return
    with mpv_lock:
        if screensaver_thread is not None and screensaver_thread.is_alive():
            return  # already running
        screensaver_stop_event.clear()
        current_kind = "screensaver"
        mpv_generation += 1
        gen = mpv_generation
    screensaver_thread = threading.Thread(target=_screensaver_loop, args=(gen, spinner), daemon=True)
    screensaver_thread.start()


def stop_screensaver():
    screensaver_stop_event.set()
    thread = screensaver_thread
    if thread is not None:
        thread.join(timeout=8)


def _screensaver_loop(gen, spinner=True):
    """Runs in its own thread: repeatedly picks a random library video and
    plays it (muted by default) until it ends naturally, then picks another
    — until screensaver_stop_event is set, or something newer (a real
    selection, or a crash-restart of the persistent mpv process) takes
    over. Individual picks are never looped — that's what keeps the
    shuffle actually shuffling. spinner is only honored for the very first
    pick — see _enter_idle_state — every pick after that always shows it."""
    last_id = None
    while not screensaver_stop_event.is_set():
        with mpv_lock:
            if gen != mpv_generation:
                return

        items = get_media()
        if not items:
            time.sleep(10)
            continue

        candidates = [i for i in items if i["id"] != last_id] or items
        pick = random.choice(candidates)
        last_id = pick["id"]

        if not _still_current(gen):
            return
        global current_screensaver_title
        with screensaver_meta_lock:
            current_screensaver_title = pick["title"]
        # Not held under mpv_lock -- _hdmi_load checks gen itself and bails
        # the instant something newer claims the generation (a real
        # selection, a crash-restart), instead of finishing this pick's
        # transition first and making the newer thing wait behind it.
        _hdmi_load(pick["path"], keep_open="no", loop_file="no",
                   mute="yes" if SCREENSAVER_MUTED else "no", spinner=spinner, gen=gen,
                   media_id=pick["id"])
        spinner = True

        while not screensaver_stop_event.is_set():
            # Sleep before checking, not after -- mpv (or the webgl page)
            # can still briefly report idle-active=true for a moment right
            # after loadfile returns, while it's still opening the file.
            # Checking immediately reads that as "this pick already
            # finished" and jumps straight to the next one, firing a second
            # transition right on top of the first.
            time.sleep(1)
            with mpv_lock:
                if gen != mpv_generation:
                    return
            if backend_get("idle-active"):
                break  # this pick finished naturally -> loop around to a new one


# ------------------------------------------------------- mpv playback ---


def _watch_mpv_playback(generation, media_id, title):
    """Runs in a background thread for as long as this generation is the
    active one. Periodically records progress; when mpv goes idle while
    this is still current — an explicit stop, or the persistent process
    having been restarted after a crash — hands off to whatever should
    show next."""
    last_pos, last_dur = None, None
    while True:
        time.sleep(2)
        with mpv_lock:
            if generation != mpv_generation:
                return  # superseded by something newer
        idle_active = backend_get("idle-active")
        if idle_active is None:
            continue  # socket hiccup / no heartbeat yet — don't mistake it for "went idle"
        if idle_active:
            break
        pos = backend_get("time-pos")
        dur = backend_get("duration")
        if pos is not None:
            last_pos, last_dur = pos, dur
            update_progress(media_id, title, pos, dur)

    if last_pos is not None:
        update_progress(media_id, title, last_pos, last_dur)

    with mpv_lock:
        still_current = generation == mpv_generation
    if still_current:
        _enter_idle_state()


def _start_mpv_playback(match, resume_seconds, loop=None, gen=None):
    if loop is None:
        loop = loop_enabled
    if gen is None:
        gen = _claim_generation("video")
    _hdmi_load(
        match["path"], keep_open="yes", loop_file="inf" if loop else "no",
        mute="no", start=str(resume_seconds) if resume_seconds > 0 else "none",
        gen=gen, media_id=match["id"],
    )
    threading.Thread(
        target=_watch_mpv_playback,
        args=(gen, match["id"], match["title"]),
        daemon=True,
    ).start()


def _is_foreground_playing():
    """True if something's been explicitly selected and is playing/paused —
    as opposed to the screensaver's own ambient picks, which don't count
    here."""
    return current_kind == "video"


# --------------------------------------------------------------- routes ---


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/projection")
def projection():
    """The fullscreen, chrome-less page a kiosk browser points at for HDMI
    output when RENDER_BACKEND=webgl -- see the module docstring's note on
    RENDER_BACKEND. Renders fine (just idle, no model) even when the mpv
    backend is active, so it's not gated behind RENDER_BACKEND itself."""
    return render_template("projection.html")


@app.route("/api/projection/model")
def api_projection_model():
    if not os.path.exists(PROJECTION_OBJ_PATH):
        return jsonify({"error": "no projection model configured"}), 404
    return send_file(PROJECTION_OBJ_PATH, mimetype="text/plain")


@app.route("/api/projection/state")
def api_projection_state():
    """Polled by the /projection page (a few times a second) to learn what
    it should currently be showing/doing."""
    with projection_lock:
        state = dict(projection_state)
    state["mapping"] = get_mapping()
    return jsonify(state)


@app.route("/api/projection/heartbeat", methods=["POST"])
def api_projection_heartbeat():
    """Posted by the /projection page every ~250ms with its current
    playback state -- the webgl-backend equivalent of polling mpv's IPC
    socket for get_property replies, just pushed instead of pulled since
    there's no persistent socket to poll here."""
    body = request.get_json(silent=True) or {}
    with projection_lock:
        projection_report.update({
            "load_seq": body.get("load_seq"),
            "position": body.get("position"),
            "duration": body.get("duration"),
            "paused": body.get("paused"),
            "idle_active": body.get("idle_active"),
            "looping": body.get("looping"),
            "frame_number": body.get("frame_number"),
            "renderer_fps": body.get("renderer_fps"),
        })
        if body.get("ack_seq") is not None:
            projection_report["ack_seq"] = body["ack_seq"]
    return jsonify({"ok": True})


@app.route("/api/projection/stats")
def api_projection_stats():
    """How the projection page is actually performing, for diagnosing a
    sluggish projector from an SSH session -- it's the HDMI output on a
    headless box, so there's no devtools to open on it otherwise."""
    with projection_lock:
        rep = dict(projection_report)
    return jsonify({
        "renderer_fps": rep.get("renderer_fps"),
        "position": rep.get("position"),
        "paused": rep.get("paused"),
    })


@app.route("/api/mapping", methods=["GET"])
def api_get_mapping():
    return jsonify(get_mapping())


@app.route("/api/mapping", methods=["POST"])
def api_set_mapping():
    """Admin-gated, same PIN pattern as the other calibration-adjacent
    endpoints -- this is a physical-setup control, not something a regular
    viewer should be able to nudge."""
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    ok, locked_seconds = check_admin_pin(str(body.get("pin", "")))
    if locked_seconds:
        return jsonify({"error": f"too many incorrect PIN attempts — try again in {locked_seconds}s"}), 429
    if not ok:
        return jsonify({"error": "incorrect PIN"}), 403
    values = {}
    for key in MAPPING_NUMERIC:
        if key in body:
            try:
                values[key] = float(body[key])
            except (TypeError, ValueError):
                return jsonify({"error": f"{key} must be a number"}), 400
    for key in MAPPING_BOOLEAN:
        if key in body:
            values[key] = bool(body[key])
    return jsonify(set_mapping(values))


@app.route("/api/loading-image")
def api_loading_image():
    if not LOADING_IMAGE_PATH or not os.path.exists(LOADING_IMAGE_PATH):
        return jsonify({"error": "no loading image configured"}), 404
    return send_file(LOADING_IMAGE_PATH)


@app.route("/api/media/<media_id>/stream")
def api_media_stream(media_id):
    """Serves a library item's raw video bytes for the /projection page's
    <video> element (RENDER_BACKEND=webgl only -- mpv opens match["path"]
    directly off disk and never hits this). conditional=True gives Range
    request support for free, which is what makes seeking work."""
    match = get_media_by_id(media_id)
    if not match:
        return jsonify({"error": "not found"}), 404
    return send_file(match["path"], conditional=True)


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


@app.route("/api/most-popular")
def api_most_popular():
    if not POPULAR_ROW_VISIBLE:
        # Short-circuits before touching play_counts.json at all, so hiding
        # the row also means not leaking counts to the client while it's
        # curated -- not just a client-side display toggle.
        return jsonify([])
    items_by_id = {i["id"]: i for i in get_media()}
    counts = get_all_play_counts()
    out = []
    for media_id, count in counts.items():
        if count <= 0:
            continue
        item = items_by_id.get(media_id)
        if not item:
            continue  # file was removed/renamed
        out.append({**item, "play_count": count})
    out.sort(key=lambda i: i["play_count"], reverse=True)
    return jsonify(out[:12])


@app.route("/api/rescan", methods=["POST"])
def api_rescan():
    get_media(force=True)
    return api_media()


@app.route("/thumbnails/<path:filename>")
def thumbnails(filename):
    return send_from_directory(THUMB_DIR, filename)


@app.route("/hero_thumbnails/<path:filename>")
def hero_thumbnails(filename):
    return send_from_directory(HERO_THUMB_DIR, filename)


@app.route("/api/media/<media_id>/attachments/<path:filename>")
def media_attachment(media_id, filename):
    """Serves a supplementary doc/image registered for media_id during the
    last scan. Only ever serves paths _find_attachment_paths already found
    on disk -- filename must match a key recorded there, so this can't be
    used to read arbitrary files (no ../.. traversal possible)."""
    get_media()  # ensure the cache (and _media_attachments) is populated
    full = _media_attachments.get(media_id, {}).get(filename)
    if not full or not os.path.isfile(full):
        return jsonify({"error": "not found"}), 404
    directory, name = os.path.split(full)
    return send_from_directory(directory, name)


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
        if not _is_foreground_playing():
            # Same reasoning as api_play: claim the generation before
            # stopping the screensaver, so a mid-transition pick notices
            # right away instead of finishing first and queuing this
            # behind it.
            gen = _claim_generation("idle")
            stop_screensaver()
            _go_idle(gen=gen)
        else:
            stop_screensaver()
    elif not _is_foreground_playing():
        # turn on and nothing's currently selected -> start it right away
        # rather than waiting for the next natural idle transition
        start_screensaver()
    return jsonify({"enabled": SCREENSAVER_ENABLED})


@app.route("/api/screensaver/start", methods=["POST"])
def api_start_screensaver_now():
    """Starts the screensaver immediately, interrupting whatever's
    currently selected if something is, and turning the enabled toggle on
    if it was off -- distinct from just flipping that toggle, which only
    auto-starts the screensaver when nothing's already playing. Stopping
    playback here is enough on its own to eventually reach the screensaver
    (_watch_mpv_playback notices mpv going idle and calls
    _enter_idle_state), but that's polled every 2s -- calling
    start_screensaver() directly makes an explicit "now" button feel
    instant, and it's a no-op if one's already running."""
    global SCREENSAVER_ENABLED
    _mark_interaction()
    SCREENSAVER_ENABLED = True
    if _is_foreground_playing():
        backend_stop()
    start_screensaver()
    return jsonify({"enabled": SCREENSAVER_ENABLED})


@app.route("/api/hero", methods=["GET"])
def api_get_hero():
    media_id = get_hero_id()
    return jsonify({"id": media_id, "hero_thumbnail": hero_thumbnail_url(media_id) if media_id else None})


@app.route("/api/hero", methods=["POST"])
def api_set_hero():
    """Pin a specific item as the browse page's featured hero. Pass
    {"id": null} to clear it and go back to the automatic pick. The poster
    thumbnail used elsewhere is too low-res for a full-width banner, so a
    larger one is generated (and cached) here the first time an item is
    pinned, rather than for every item up front at scan time."""
    body = request.get_json(silent=True) or {}
    media_id = body.get("id")
    hero_thumbnail = None
    if media_id is not None:
        match = get_media_by_id(media_id)
        if not match:
            return jsonify({"error": "not found"}), 404
        hero_thumbnail = ensure_hero_thumbnail(media_id, match["path"])
    set_hero_id(media_id)
    return jsonify({"id": media_id, "hero_thumbnail": hero_thumbnail})


@app.route("/api/media/<media_id>/preview")
def api_media_preview(media_id):
    """Generates (or reuses the cached) full-res hero banner image for an
    item so the browse page can show it while a poster is selected but not
    yet playing -- title/category/description are already available
    client-side from /api/media, so this only needs to hand back the one
    thing that requires server-side work."""
    match = get_media_by_id(media_id)
    if not match:
        return jsonify({"error": "not found"}), 404
    return jsonify({"id": media_id, "hero_thumbnail": ensure_hero_thumbnail(media_id, match["path"])})


def check_admin_pin(candidate):
    """Verifies candidate against ADMIN_PIN, enforcing a per-client-IP
    lockout after ADMIN_MAX_ATTEMPTS wrong guesses in a row -- checked here
    rather than only in api_admin_unlock so the rename endpoint (which
    re-verifies the PIN independently) can't be used to route around it.
    Returns (ok, locked_seconds); when locked_seconds is truthy the PIN
    wasn't even compared this time, ok is always False."""
    ip = request.remote_addr
    with admin_lock:
        entry = admin_attempts.get(ip)
        if entry and entry["locked_until"] is not None:
            remaining = entry["locked_until"] - time.monotonic()
            if remaining > 0:
                return False, round(remaining)
            admin_attempts.pop(ip, None)  # lockout expired

        correct = candidate == ADMIN_PIN
        if correct:
            admin_attempts.pop(ip, None)
            return True, 0

        entry = admin_attempts.setdefault(ip, {"count": 0, "locked_until": None})
        entry["count"] += 1
        if entry["count"] >= ADMIN_MAX_ATTEMPTS:
            entry["locked_until"] = time.monotonic() + ADMIN_LOCKOUT_SECONDS
            entry["count"] = 0
        return False, 0


@app.route("/api/admin/unlock", methods=["POST"])
def api_admin_unlock():
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    ok, locked_seconds = check_admin_pin(str(body.get("pin", "")))
    if locked_seconds:
        return jsonify({"ok": False, "locked_seconds": locked_seconds}), 429
    return jsonify({"ok": ok})


@app.route("/api/play-tracking", methods=["GET"])
def api_get_play_tracking():
    return jsonify({"enabled": PLAY_TRACKING_ENABLED})


@app.route("/api/play-tracking", methods=["POST"])
def api_set_play_tracking():
    """Admin-gated, unlike /api/screensaver's toggle -- deliberately playing
    with the UI while testing shouldn't silently inflate "Most Popular", so
    turning tracking on requires the same PIN as renaming/uploading."""
    global PLAY_TRACKING_ENABLED
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    ok, locked_seconds = check_admin_pin(str(body.get("pin", "")))
    if locked_seconds:
        return jsonify({"error": f"too many incorrect PIN attempts — try again in {locked_seconds}s"}), 429
    if not ok:
        return jsonify({"error": "incorrect PIN"}), 403
    PLAY_TRACKING_ENABLED = bool(body.get("enabled"))
    return jsonify({"enabled": PLAY_TRACKING_ENABLED})


@app.route("/api/popular-visibility", methods=["GET"])
def api_get_popular_visibility():
    return jsonify({"enabled": POPULAR_ROW_VISIBLE})


@app.route("/api/popular-visibility", methods=["POST"])
def api_set_popular_visibility():
    global POPULAR_ROW_VISIBLE
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    ok, locked_seconds = check_admin_pin(str(body.get("pin", "")))
    if locked_seconds:
        return jsonify({"error": f"too many incorrect PIN attempts — try again in {locked_seconds}s"}), 429
    if not ok:
        return jsonify({"error": "incorrect PIN"}), 403
    POPULAR_ROW_VISIBLE = bool(body.get("enabled"))
    return jsonify({"enabled": POPULAR_ROW_VISIBLE})


@app.route("/api/media/<media_id>/rename", methods=["POST"])
def api_rename_media(media_id):
    """Renaming here only overrides the display title (see
    set_title_override) — it never touches the underlying file, so
    thumbnails, progress, and hero pinning (all keyed off the original file
    path) stay intact."""
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    ok, locked_seconds = check_admin_pin(str(body.get("pin", "")))
    if locked_seconds:
        return jsonify({"error": f"too many incorrect PIN attempts — try again in {locked_seconds}s"}), 429
    if not ok:
        return jsonify({"error": "incorrect PIN"}), 403
    if not get_media_by_id(media_id):
        return jsonify({"error": "not found"}), 404
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    set_title_override(media_id, title)
    get_media(force=True)
    return jsonify({"id": media_id, "title": title})


@app.route("/api/admin/upload", methods=["POST"])
def api_upload_media():
    """PIN-gated video upload, with optional supplementary docs/images
    uploaded alongside it. pin/category arrive as regular form fields
    alongside the file (not JSON) since this is a multipart/form-data
    request. category becomes a top-level subfolder of MEDIA_DIR -- the
    same thing _build_media_item derives a card's category from -- so an
    uploaded file shows up in the matching row (or a new one) after
    rescan. Any files under the "attachments" field go straight into the
    new video's <stem>.attachments/ folder (see _video_attachment_dir),
    the same place _migrate_video_sidecars would eventually move loose
    ones to -- so there's nothing to migrate for videos uploaded this way."""
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    ok, locked_seconds = check_admin_pin(str(request.form.get("pin", "")))
    if locked_seconds:
        return jsonify({"error": f"too many incorrect PIN attempts — try again in {locked_seconds}s"}), 429
    if not ok:
        return jsonify({"error": "incorrect PIN"}), 403

    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": "no file provided"}), 400

    ext = Path(upload.filename).suffix.lower()
    if ext not in VIDEO_EXTS:
        return jsonify({"error": f"unsupported file type {ext or '(none)'}"}), 400

    filename = secure_filename(Path(upload.filename).stem) + ext
    if not filename or filename == ext:
        return jsonify({"error": "invalid filename"}), 400

    category = secure_filename((request.form.get("category") or "").strip())
    dest_dir = os.path.join(MEDIA_DIR, category) if category else MEDIA_DIR
    os.makedirs(dest_dir, exist_ok=True)

    dest_path = os.path.join(dest_dir, filename)
    if os.path.exists(dest_path):
        stem, n = Path(filename).stem, 2
        while os.path.exists(dest_path):
            dest_path = os.path.join(dest_dir, f"{stem} ({n}){ext}")
            n += 1

    upload.save(dest_path)

    attachments = [f for f in request.files.getlist("attachments") if f and f.filename]
    if attachments:
        attach_dir = _video_attachment_dir(dest_path)
        os.makedirs(attach_dir, exist_ok=True)
        for att in attachments:
            att_ext = Path(att.filename).suffix.lower()
            if att_ext not in ATTACHMENT_EXTS:
                continue  # silently skip rather than fail the whole upload
            att_filename = secure_filename(Path(att.filename).stem) + att_ext
            if not att_filename or att_filename == att_ext:
                continue
            att_dest = os.path.join(attach_dir, att_filename)
            if os.path.exists(att_dest):
                att_stem, n = Path(att_filename).stem, 2
                while os.path.exists(att_dest):
                    att_dest = os.path.join(attach_dir, f"{att_stem} ({n}){att_ext}")
                    n += 1
            att.save(att_dest)

    get_media(force=True)
    item = next((i for i in get_media() if i["path"] == dest_path), None)
    return jsonify({"ok": True, "item": item})


@app.route("/api/play/<media_id>", methods=["POST"])
def api_play(media_id):
    _mark_interaction()
    match = get_media_by_id(media_id)
    if not match:
        return jsonify({"error": "not found"}), 404

    if PLAY_TRACKING_ENABLED:
        increment_play_count(media_id)

    body = request.get_json(silent=True) or {}
    # resume=True is only sent for a normal click in the Continue Watching
    # row -- every other selection (browse grid, hero) starts from the
    # beginning, even if there's saved progress for it. restart=True is
    # the row's own explicit "start over" button: also from the
    # beginning, but additionally clears the saved progress, since that's
    # a deliberate "forget where I was" action rather than just "don't
    # resume this time".
    resume = bool(body.get("resume"))
    restart_from_beginning = bool(body.get("restart"))

    saved = get_progress(media_id) if resume else None
    resume_seconds = 0.0
    if saved and saved.get("duration") and RESUME_MIN_SECONDS <= saved["position"] < saved["duration"] * RESUME_MAX_FRACTION:
        resume_seconds = max(0, saved["position"] - 3)  # small rewind buffer
    if restart_from_beginning:
        clear_progress(media_id)

    with meta_lock:
        current_media_meta.update({
            "id": match["id"], "title": match["title"],
            "description": match.get("description"),
            "is_sequence": match.get("is_sequence", False),
            "frame_count": match.get("frame_count"),
            "thumbnail": match.get("thumbnail"),
        })

    # Claim the generation *before* stopping the screensaver, not after --
    # if a screensaver pick is mid-transition right now, this makes it
    # notice immediately (its gen is now stale) and bail out instead of
    # finishing first and making this selection's own transition wait
    # behind it, which is what produced a visible double transition.
    gen = _claim_generation("video")
    stop_screensaver()
    _start_mpv_playback(match, resume_seconds=resume_seconds, gen=gen)

    return jsonify({"status": "playing", "title": match["title"], "id": media_id})


@app.route("/api/control/<action>", methods=["POST"])
def api_control(action):
    global loop_enabled
    _mark_interaction()

    # Maps the dock's action names onto backend_control()'s own action
    # vocabulary -- volume isn't otherwise a backend_control action since
    # nothing else needs it, so it's handled as a direct dispatch below.
    backend_actions = {
        "pause": "toggle_pause",
        "stop": "stop",
        # both backends pause automatically after stepping, which is
        # exactly what you want for frame-accurate scrubbing.
        "seek_forward": "frame_step",
        "seek_backward": "frame_back_step",
        "loop": "toggle_loop",
    }
    if action in ("volume_up", "volume_down"):
        delta = 5 if action == "volume_up" else -5
        if RENDER_BACKEND != "webgl":
            result = mpv_send({"command": ["add", "volume", delta]})
        else:
            result = backend_control("volume", value=delta, wait=False)
        return jsonify({"result": result})
    if action not in backend_actions:
        return jsonify({"error": "unknown action"}), 400

    result = backend_control(backend_actions[action])
    if action == "pause":
        # toggling pause doesn't report the resulting state, so read it back
        return jsonify({"result": result, "paused": backend_get("pause")})
    if action in ("seek_forward", "seek_backward"):
        # both leave playback paused; report the resulting frame number so
        # the dock can show "Frame 3 of 5" immediately for sequences,
        # without waiting on a poll
        return jsonify({"result": result, "frame_number": backend_get("estimated-frame-number")})
    if action == "loop":
        data = backend_get("loop-file")
        loop_enabled = data not in (None, False, "no")
        return jsonify({"result": result, "looping": loop_enabled})
    return jsonify({"result": result})


@app.route("/api/seek_to", methods=["POST"])
def api_seek_to():
    _mark_interaction()
    seconds = request.get_json(force=True).get("seconds")
    if seconds is None:
        return jsonify({"error": "seconds required"}), 400
    return jsonify({"result": backend_control("seek", value=seconds)})


@app.route("/api/status")
def api_status():
    if current_kind == "screensaver":
        with screensaver_meta_lock:
            title = current_screensaver_title
        return jsonify({"playing": False, "screensaver": True, "screensaver_title": title})
    if current_kind != "video":
        return jsonify({"playing": False, "screensaver": False})

    prop = backend_get

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
            "looping": prop("loop-file") not in (None, False, "no"),
            "id": media_id,
            "filename": prop("filename"),
            "title": title,
            "description": description,
            "is_sequence": is_sequence,
            "frame_count": frame_count,
            # only worth the extra IPC round-trip for sequences, where the
            # dock actually shows a frame counter
            "frame_number": prop("estimated-frame-number") if is_sequence else None,
        }
    )


if __name__ == "__main__":
    if RENDER_BACKEND == "webgl":
        print(f"[projection] webgl backend active -- point a kiosk browser at "
              f"http://localhost:{os.environ.get('ZEALANDATA_PORT', '8000')}/projection")
    else:
        _spawn_hdmi_process()
        threading.Thread(target=_hdmi_supervisor_loop, daemon=True).start()
    _go_idle(spinner=False)
    threading.Thread(target=_boot_grace_then_screensaver, daemon=True).start()
    threading.Thread(target=_idle_watcher_loop, daemon=True).start()
    port = int(os.environ.get("ZEALANDATA_PORT", "8000"))
    app.run(host="0.0.0.0", port=port, threaded=True)
