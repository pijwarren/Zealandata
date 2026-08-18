#!/bin/bash
# Zealandata bootstrap
# =====================
# Takes a fresh Raspberry Pi OS Lite install to a fully working Zealandata
# setup in one run. Safe to re-run (idempotent) — e.g. after a fresh
# `git pull` you don't need this again, but running it again won't break
# anything either.
#
# Usage:
#   curl -O https://raw.githubusercontent.com/pijwarren/Zealandata/main/zealandata_bootstrap.sh
#   chmod +x zealandata_bootstrap.sh
#   ./zealandata_bootstrap.sh
#
# Or just copy this file onto the Pi any way you like and run it.
#
# NOTE: this setup step itself needs internet access (to install packages
# and clone the repo) — run it while the Pi's on your normal wifi/ethernet,
# *before* switching it over to broadcast its own ad-hoc hotspot. Once
# everything's installed, Zealandata itself runs fully offline.

set -euo pipefail

REPO_URL="https://github.com/pijwarren/Zealandata.git"
INSTALL_DIR="$HOME/zealandata"
MEDIA_DIR="$HOME/media"
CURRENT_USER="$(whoami)"

echo "=== Zealandata bootstrap ==="
echo "User:       $CURRENT_USER"
echo "Install to: $INSTALL_DIR"
echo "Media dir:  $MEDIA_DIR"
echo

# ---------------------------------------------------------------- packages
echo "--- Installing dependencies (mpv, ffmpeg, python3, git) ---"
sudo apt update
sudo apt install -y mpv ffmpeg python3-pip git

echo "--- Installing Flask ---"
pip3 install flask --break-system-packages --quiet

# --------------------------------------------------------- screen access
echo "--- Granting video/render device access (needed for DRM output) ---"
sudo usermod -aG video,render "$CURRENT_USER"

# ------------------------------------------------------------------- repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "--- Existing install found — pulling latest instead of re-cloning ---"
  git -C "$INSTALL_DIR" pull
elif [ -d "$INSTALL_DIR" ]; then
  echo "ERROR: $INSTALL_DIR already exists but isn't a git repo (probably an"
  echo "older manual install, from before this script existed). Rename it"
  echo "out of the way first, then re-run this script:"
  echo "  mv $INSTALL_DIR ${INSTALL_DIR}-old"
  exit 1
else
  echo "--- Cloning Zealandata ---"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ------------------------------------------------------------- media dir
mkdir -p "$MEDIA_DIR"
echo "--- Media directory ready at $MEDIA_DIR ---"
echo "    (drop video files / category subfolders in here, then Rescan"
echo "    from the web UI's Settings panel once it's running)"

# --------------------------------------------------------- systemd service
echo "--- Installing systemd service ---"
SERVICE_SRC="$INSTALL_DIR/zealandata.service"
SERVICE_TMP="$(mktemp)"

# The repo's service file is written with placeholder paths — substitute in
# whoever's actually running this script, so it works for any user/host,
# not just the one it happened to be developed on.
sed \
  -e "s|^User=.*|User=$CURRENT_USER|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" \
  -e "s|^ExecStart=.*|ExecStart=/usr/bin/python3 $INSTALL_DIR/server.py|" \
  -e "s|^Environment=ZEALANDATA_MEDIA_DIR=.*|Environment=ZEALANDATA_MEDIA_DIR=$MEDIA_DIR|" \
  "$SERVICE_SRC" > "$SERVICE_TMP"

sudo cp "$SERVICE_TMP" /etc/systemd/system/zealandata.service
rm -f "$SERVICE_TMP"

sudo systemctl daemon-reload
sudo systemctl enable --now zealandata

# ------------------------------------------------------------------ done
echo
echo "=== Done ==="
echo
sleep 2
if systemctl is-active --quiet zealandata; then
  echo "zealandata.service is running."
else
  echo "zealandata.service did NOT start cleanly — check the logs:"
  echo "  journalctl -u zealandata -n 50 --no-pager"
fi

IP_ADDR="$(hostname -I | awk '{print $1}')"
echo
echo "Browse to:  http://${IP_ADDR:-<pi-ip-address>}:8000"
echo
echo "If you just got added to the video/render groups for the first time,"
echo "a reboot is recommended before DRM output will work correctly:"
echo "  sudo reboot"
