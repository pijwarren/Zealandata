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
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, render_template

# ---------------------------------------------------------------- config ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.environ.get("ZEALANDATA_MEDIA_DIR", "/home/pi/media")
THUMB_DIR = os.path.join(BASE_DIR, "static", "thumbnails")
HERO_THUMB_DIR = os.path.join(BASE_DIR, "static", "hero_thumbnails")
SEQUENCE_CACHE_DIR = os.path.join(BASE_DIR, "static", "sequence_cache")
PROGRESS_FILE = os.path.join(BASE_DIR, "progress.json")
HERO_FILE = os.path.join(BASE_DIR, "hero.json")
TITLES_FILE = os.path.join(BASE_DIR, "titles.json")

MPV_SOCKET = "/tmp/zealandata-mpv.sock"

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

# Screensaver: when nothing's been chosen, shuffle through random videos
# from the library itself.
SCREENSAVER_ENABLED = os.environ.get("ZEALANDATA_SCREENSAVER_ENABLED", "1") == "1"
SCREENSAVER_MUTED = os.environ.get("ZEALANDATA_SCREENSAVER_MUTED", "1") == "1"

# Default behavior when a selected video reaches the end: mpv pauses on the
# last frame (see keep-open=yes below), so it can be scrubbed back and
# forth rather than the screensaver kicking back in automatically. Set this
# to loop the video indefinitely instead — screensaver picks are never
# looped individually either way, only a deliberate selection.
LOOP_SELECTED_VIDEO = os.environ.get("ZEALANDATA_LOOP_SELECTED", "0") == "1"

# If something's left PAUSED (not stopped) for this long with no further
# interaction, automatically stop it and fall back to the screensaver.
# Doesn't affect actively-playing/looping video — only abandoned pauses.
IDLE_TIMEOUT_ENABLED = os.environ.get("ZEALANDATA_IDLE_TIMEOUT_ENABLED", "0") == "1"
IDLE_TIMEOUT_SECONDS = float(os.environ.get("ZEALANDATA_IDLE_TIMEOUT_SECONDS", "300"))

# Optional: a static image shown whenever there's genuinely nothing else
# queued (server just started, playback was explicitly stopped, or the
# screensaver is off) — held indefinitely rather than leaving the Linux
# console underneath as the last thing on screen. No-op if unset.
LOADING_IMAGE_PATH = os.environ.get("ZEALANDATA_LOADING_IMAGE", "").strip() or None

# Optional: a 4-digit PIN that gates "admin mode" in the web UI (currently
# just renaming videos). Unset by default -- the admin-mode UI and its
# endpoints are simply unavailable until you set one.
ADMIN_PIN = os.environ.get("ZEALANDATA_ADMIN_PIN", "").strip() or None

# Resume threshold: only offer/apply "continue watching" if between these
# fractions of the way through (avoids resuming a 3-second stub, and avoids
# "resuming" something that's basically already finished).
RESUME_MIN_SECONDS = 10
RESUME_MAX_FRACTION = 0.95

os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(HERO_THUMB_DIR, exist_ok=True)
os.makedirs(SEQUENCE_CACHE_DIR, exist_ok=True)

app = Flask(__name__)

mpv_process = None
mpv_lock = threading.Lock()
mpv_generation = 0  # bumped every time ownership of the persistent mpv
                     # process changes hands (idle / a selected video /
                     # a screensaver session) — lets a stale watcher or
                     # screensaver loop recognize it's been superseded

current_kind = "idle"  # "idle" | "video" | "screensaver" — whatever the
                        # persistent mpv process is currently showing

screensaver_thread = None
screensaver_stop_event = threading.Event()

# Metadata for whatever's currently playing — mainly so /api/status can
# report a description without mpv needing to know what one is.
meta_lock = threading.Lock()
current_media_meta = {"id": None, "title": None, "description": None, "is_sequence": False, "frame_count": None, "thumbnail": None}

# Last time any playback-control endpoint was hit — drives the idle timeout.
_interaction_lock = threading.Lock()
_last_interaction = time.monotonic()

_media_cache = {"items": None, "mtime": 0}

progress_lock = threading.Lock()
hero_lock = threading.Lock()
titles_lock = threading.Lock()

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


def hero_thumbnail_url(media_id):
    """The full-res hero banner image for this item, generated on demand
    the first time it's pinned as hero (see api_set_hero) — None if it
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


# ------------------------------------------------------------- mpv IPC ---


def mpv_send(command):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(MPV_SOCKET)
            s.sendall((json.dumps(command) + "\n").encode())
            resp = s.recv(4096)
            return json.loads(resp.decode()) if resp else None
    except (FileNotFoundError, ConnectionRefusedError, OSError, socket.timeout):
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
    global mpv_process
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
        print("[mpv] 'mpv' not found on PATH — HDMI playback won't work")
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
            if _mpv_is_running():
                continue
            print("[mpv] persistent HDMI process died — restarting")
            _spawn_hdmi_process()
            mpv_generation += 1
        _enter_idle_state()


def _hdmi_load(path, keep_open, loop_file, mute, start="none", image_duration=None):
    """Set the playback properties that should apply to the next file, then
    load it. Done as separate set_property calls (rather than loadfile's
    own trailing "options" argument) since that argument's exact position
    varies across mpv versions and isn't worth chasing down per-build.
    "pause" is reset explicitly too -- unlike the others, it's not a
    per-file property, so pausing one video and then stopping it would
    otherwise leave the *next* thing loaded (a screensaver pick, another
    video) starting paused as well."""
    if image_duration is not None:
        mpv_send({"command": ["set_property", "image-display-duration", image_duration]})
    mpv_send({"command": ["set_property", "keep-open", keep_open]})
    mpv_send({"command": ["set_property", "loop-file", loop_file]})
    mpv_send({"command": ["set_property", "mute", mute]})
    mpv_send({"command": ["set_property", "start", start]})
    mpv_send({"command": ["set_property", "pause", "no"]})
    mpv_send({"command": ["loadfile", path, "replace"]})


def _go_idle():
    """Show the loading image, held indefinitely, if one's configured;
    otherwise just unload whatever was playing and sit on mpv's own idle
    black frame."""
    global current_kind
    current_kind = "idle"
    if LOADING_IMAGE_PATH and os.path.exists(LOADING_IMAGE_PATH):
        _hdmi_load(LOADING_IMAGE_PATH, keep_open="yes", loop_file="no",
                   mute="yes", image_duration="inf")
    else:
        mpv_send({"command": ["stop"]})


def _enter_idle_state():
    """Called whenever HDMI has nothing queued next. Prefers the
    screensaver when it's enabled; otherwise holds the idle image so the
    console is never what ends up on screen."""
    if SCREENSAVER_ENABLED:
        start_screensaver()
    else:
        global mpv_generation
        with mpv_lock:
            mpv_generation += 1
        _go_idle()


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
            r = mpv_send({"command": ["get_property", "pause"]})
            if r and r.get("data"):
                mpv_send({"command": ["stop"]})
                _mark_interaction()


# --------------------------------------------------------- screensaver ---


def start_screensaver():
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
    screensaver_thread = threading.Thread(target=_screensaver_loop, args=(gen,), daemon=True)
    screensaver_thread.start()


def stop_screensaver():
    screensaver_stop_event.set()
    thread = screensaver_thread
    if thread is not None:
        thread.join(timeout=8)


def _screensaver_loop(gen):
    """Runs in its own thread: repeatedly picks a random library video and
    plays it (muted by default) until it ends naturally, then picks another
    — until screensaver_stop_event is set, or something newer (a real
    selection, or a crash-restart of the persistent mpv process) takes
    over. Individual picks are never looped — that's what keeps the
    shuffle actually shuffling."""
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

        with mpv_lock:
            if gen != mpv_generation:
                return
            _hdmi_load(pick["path"], keep_open="no", loop_file="no",
                       mute="yes" if SCREENSAVER_MUTED else "no")

        while not screensaver_stop_event.is_set():
            with mpv_lock:
                if gen != mpv_generation:
                    return
            r = mpv_send({"command": ["get_property", "idle-active"]})
            if r and r.get("data"):
                break  # this pick finished naturally -> loop around to a new one
            time.sleep(1)


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
        r = mpv_send({"command": ["get_property", "idle-active"]})
        if r is None:
            continue  # socket hiccup — don't mistake it for "went idle"
        if r.get("data"):
            break
        pos_r = mpv_send({"command": ["get_property", "time-pos"]})
        dur_r = mpv_send({"command": ["get_property", "duration"]})
        pos = pos_r.get("data") if pos_r else None
        dur = dur_r.get("data") if dur_r else None
        if pos is not None:
            last_pos, last_dur = pos, dur
            update_progress(media_id, title, pos, dur)

    if last_pos is not None:
        update_progress(media_id, title, last_pos, last_dur)

    with mpv_lock:
        still_current = generation == mpv_generation
    if still_current:
        _enter_idle_state()


def _start_mpv_playback(match, resume_seconds, loop=None):
    global mpv_generation, current_kind
    if loop is None:
        loop = LOOP_SELECTED_VIDEO
    with mpv_lock:
        current_kind = "video"
        mpv_generation += 1
        gen = mpv_generation
        _hdmi_load(
            match["path"], keep_open="yes", loop_file="inf" if loop else "no",
            mute="no", start=str(resume_seconds) if resume_seconds > 0 else "none",
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


@app.route("/hero_thumbnails/<path:filename>")
def hero_thumbnails(filename):
    return send_from_directory(HERO_THUMB_DIR, filename)


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
        if not _is_foreground_playing():
            _enter_idle_state()
    elif not _is_foreground_playing():
        # turn on and nothing's currently selected -> start it right away
        # rather than waiting for the next natural idle transition
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
        thumb_path = os.path.join(HERO_THUMB_DIR, f"{media_id}.jpg")
        if not os.path.exists(thumb_path):
            _generate_hero_thumbnail(match["path"], thumb_path)
        hero_thumbnail = hero_thumbnail_url(media_id)
    set_hero_id(media_id)
    return jsonify({"id": media_id, "hero_thumbnail": hero_thumbnail})


@app.route("/api/admin/unlock", methods=["POST"])
def api_admin_unlock():
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    return jsonify({"ok": str(body.get("pin", "")) == ADMIN_PIN})


@app.route("/api/media/<media_id>/rename", methods=["POST"])
def api_rename_media(media_id):
    """Renaming here only overrides the display title (see
    set_title_override) — it never touches the underlying file, so
    thumbnails, progress, and hero pinning (all keyed off the original file
    path) stay intact."""
    if not ADMIN_PIN:
        return jsonify({"error": "admin mode isn't configured on this server"}), 404
    body = request.get_json(silent=True) or {}
    if str(body.get("pin", "")) != ADMIN_PIN:
        return jsonify({"error": "incorrect PIN"}), 403
    if not get_media_by_id(media_id):
        return jsonify({"error": "not found"}), 404
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    set_title_override(media_id, title)
    get_media(force=True)
    return jsonify({"id": media_id, "title": title})


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
    _start_mpv_playback(match, resume_seconds=resume_seconds)

    return jsonify({"status": "playing", "title": match["title"], "id": media_id})


@app.route("/api/control/<action>", methods=["POST"])
def api_control(action):
    _mark_interaction()

    mapping = {
        "pause": {"command": ["cycle", "pause"]},
        "stop": {"command": ["stop"]},
        # mpv pauses automatically after stepping, which is exactly what you
        # want for frame-accurate scrubbing.
        "seek_forward": {"command": ["frame-step"]},
        "seek_backward": {"command": ["frame-back-step"]},
        "volume_up": {"command": ["add", "volume", 5]},
        "volume_down": {"command": ["add", "volume", -5]},
        "loop": {"command": ["cycle-values", "loop-file", "inf", "no"]},
    }
    if action not in mapping:
        return jsonify({"error": "unknown action"}), 400
    result = mpv_send(mapping[action])
    if action == "pause":
        # "cycle pause" doesn't report the resulting state, so read it back
        paused = mpv_send({"command": ["get_property", "pause"]})
        return jsonify({"result": result, "paused": paused.get("data") if paused else None})
    if action in ("seek_forward", "seek_backward"):
        # both leave mpv paused; report the resulting frame number so the
        # dock can show "Frame 3 of 5" immediately for sequences, without
        # waiting on a poll
        frame_r = mpv_send({"command": ["get_property", "estimated-frame-number"]})
        return jsonify({"result": result, "frame_number": frame_r.get("data") if frame_r else None})
    if action == "loop":
        loop_r = mpv_send({"command": ["get_property", "loop-file"]})
        data = loop_r.get("data") if loop_r else None
        return jsonify({"result": result, "looping": data not in (None, False, "no")})
    return jsonify({"result": result})


@app.route("/api/seek_to", methods=["POST"])
def api_seek_to():
    _mark_interaction()
    seconds = request.get_json(force=True).get("seconds")
    if seconds is None:
        return jsonify({"error": "seconds required"}), 400
    return jsonify({"result": mpv_send({"command": ["seek", seconds, "absolute"]})})


@app.route("/api/status")
def api_status():
    if current_kind != "video":
        return jsonify({"playing": False})

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
    _spawn_hdmi_process()
    _go_idle()
    threading.Thread(target=_hdmi_supervisor_loop, daemon=True).start()
    start_screensaver()
    threading.Thread(target=_idle_watcher_loop, daemon=True).start()
    port = int(os.environ.get("ZEALANDATA_PORT", "8000"))
    app.run(host="0.0.0.0", port=port, threaded=True)
