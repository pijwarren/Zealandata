const grid = document.getElementById("categoryRows");
const emptyEl = document.getElementById("empty");
const continueRow = document.getElementById("continueRow");
const continueGrid = document.getElementById("continueGrid");
const dock = document.getElementById("dock");
const dockTitle = document.getElementById("dockTitle");
const dockNdiBadge = document.getElementById("dockNdiBadge");
const dockDescription = document.getElementById("dockDescription");
const dockPos = document.getElementById("dockPos");
const dockPreviewWrap = document.getElementById("dockPreviewWrap");
const dockPreview = document.getElementById("dockPreview");
const dockDur = document.getElementById("dockDur");
const dockTime = document.getElementById("dockTime");
const dockFrameCounter = document.getElementById("dockFrameCounter");
const dockBar = document.getElementById("dockBar");
const dockBarFill = document.getElementById("dockBarFill");
const dockBarHandle = document.getElementById("dockBarHandle");
const btnPause = document.getElementById("btnPause");
const btnSeekBack = document.getElementById("btnSeekBack");
const btnSeekFwd = document.getElementById("btnSeekFwd");
const btnFrameBack = document.getElementById("btnFrameBack");
const btnFrameFwd = document.getElementById("btnFrameFwd");
const rescanBtn = document.getElementById("rescanBtn");
const outputHdmiBtn = document.getElementById("outputHdmiBtn");
const outputNdiBtn = document.getElementById("outputNdiBtn");
const outputNdiWarn = document.getElementById("outputNdiWarn");
const outputToggle = document.getElementById("outputToggle");

function fmtTime(s) {
  if (s == null || isNaN(s)) return "0:00";
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

async function loadMedia() {
  const [mediaRes, continueRes] = await Promise.all([
    fetch("/api/media"),
    fetch("/api/continue-watching"),
  ]);
  renderGrid(await mediaRes.json());
  renderContinueRow(await continueRes.json());
}

function buildCard(item, { badge, showRestart } = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Play ${item.title}`);

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "card__frame";
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.className = "card__thumb";
    img.src = item.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    thumbWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "card__thumb card__thumb--placeholder";
    ph.textContent = "🎞";
    thumbWrap.appendChild(ph);
  }

  const glow = document.createElement("div");
  glow.className = "card__glow";
  thumbWrap.appendChild(glow);

  const scrim = document.createElement("div");
  scrim.className = "card__scrim";
  thumbWrap.appendChild(scrim);

  const playGlyph = document.createElement("div");
  playGlyph.className = "card__play";
  playGlyph.textContent = "▶";
  thumbWrap.appendChild(playGlyph);

  if (badge) {
    const b = document.createElement("div");
    b.className = "card__resume-badge";
    b.textContent = badge;
    thumbWrap.appendChild(b);
  }

  if (showRestart) {
    const r = document.createElement("button");
    r.className = "card__restart";
    r.title = "Start over from the beginning";
    r.setAttribute("aria-label", `Restart ${item.title} from the beginning`);
    r.textContent = "↺";
    r.addEventListener("click", (e) => {
      e.stopPropagation();
      playItem(item, { restart: true });
    });
    thumbWrap.appendChild(r);
  }

  if (item.progress && item.progress.duration) {
    const bar = document.createElement("div");
    bar.className = "card__progress";
    const fill = document.createElement("div");
    fill.className = "card__progress-fill";
    const pct = Math.min(100, (item.progress.position / item.progress.duration) * 100);
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    thumbWrap.appendChild(bar);
  }

  const title = document.createElement("div");
  title.className = "card__title";
  title.textContent = item.title;
  thumbWrap.appendChild(title);

  card.appendChild(thumbWrap);

  const play = () => playItem(item);
  card.addEventListener("click", play);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); }
  });

  return card;
}

function wrapScroller(scroller) {
  const viewport = document.createElement("div");
  viewport.className = "row__viewport";
  scroller.parentNode.insertBefore(viewport, scroller);
  viewport.appendChild(scroller);

  const leftBtn = document.createElement("button");
  leftBtn.className = "row__arrow row__arrow--left hidden";
  leftBtn.setAttribute("aria-label", "Scroll left");
  leftBtn.textContent = "‹";

  const rightBtn = document.createElement("button");
  rightBtn.className = "row__arrow row__arrow--right hidden";
  rightBtn.setAttribute("aria-label", "Scroll right");
  rightBtn.textContent = "›";

  viewport.insertBefore(leftBtn, scroller);
  viewport.appendChild(rightBtn);

  function update() {
    const max = scroller.scrollWidth - scroller.clientWidth;
    leftBtn.classList.toggle("hidden", scroller.scrollLeft <= 4);
    rightBtn.classList.toggle("hidden", max <= 4 || scroller.scrollLeft >= max - 4);
  }

  leftBtn.addEventListener("click", () => {
    scroller.scrollBy({ left: -scroller.clientWidth * 0.9, behavior: "smooth" });
  });
  rightBtn.addEventListener("click", () => {
    scroller.scrollBy({ left: scroller.clientWidth * 0.9, behavior: "smooth" });
  });
  scroller.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  update();

  return update;
}

const continueScrollUpdate = wrapScroller(continueGrid);

function renderGrid(items) {
  grid.innerHTML = "";
  emptyEl.classList.toggle("hidden", items.length > 0);
  if (items.length === 0) return;

  const byCategory = new Map();
  for (const item of items) {
    const cat = item.category || "Uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(item);
  }

  // If everything lives loose at the top of the media folder (no
  // subfolders used at all), just show one plain "Library" shelf
  // instead of a single row oddly labeled "Uncategorized".
  const categoryNames = [...byCategory.keys()];
  const onlyFlat = categoryNames.length === 1 && categoryNames[0] === "Uncategorized";

  const sortedNames = onlyFlat
    ? categoryNames
    : categoryNames.sort((a, b) => {
        if (a === "Uncategorized") return 1;
        if (b === "Uncategorized") return -1;
        return a.localeCompare(b);
      });

  for (const name of sortedNames) {
    const section = document.createElement("section");
    section.className = "row";
    section.setAttribute("aria-label", name);

    const heading = document.createElement("h2");
    heading.className = "row__heading";
    heading.textContent = onlyFlat ? "Library" : name;
    section.appendChild(heading);

    const scroller = document.createElement("div");
    scroller.className = "row__scroller";
    for (const item of byCategory.get(name)) {
      scroller.appendChild(buildCard(item));
    }
    section.appendChild(scroller);
    wrapScroller(scroller);

    grid.appendChild(section);
  }
}

function renderContinueRow(items) {
  continueGrid.innerHTML = "";
  continueRow.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const remaining = item.progress.duration - item.progress.position;
    const badge = remaining > 60 ? `${fmtTime(remaining)} left` : "Almost done";
    continueGrid.appendChild(buildCard(item, { badge, showRestart: true }));
  }
  continueScrollUpdate();
}

let currentFrameCount = null;

function setSequenceMode(isSequence, frameCount, frameNumber) {
  currentFrameCount = isSequence ? frameCount : null;
  dockTime.classList.toggle("hidden", isSequence);
  dockFrameCounter.classList.toggle("hidden", !isSequence);
  btnSeekBack.classList.toggle("hidden", isSequence);
  btnSeekFwd.classList.toggle("hidden", isSequence);
  btnFrameBack.classList.toggle("hidden", !isSequence);
  btnFrameFwd.classList.toggle("hidden", !isSequence);
  if (isSequence) {
    paintFrameCounter(frameNumber);
  }
}

function paintFrameCounter(frameNumber) {
  const shown = frameNumber != null ? frameNumber + 1 : "—";
  const total = currentFrameCount != null ? currentFrameCount : "—";
  dockFrameCounter.textContent = `Frame ${shown} of ${total}`;
}

async function playItem(item, { restart = false } = {}) {
  dockTitle.textContent = item.title;
  dockDescription.textContent = item.description || "";
  dockDescription.classList.toggle("hidden", !item.description);
  setSequenceMode(!!item.is_sequence, item.frame_count, 0);
  paintPreview(item.thumbnail);
  dock.classList.remove("hidden");
  setPauseIcon(false);
  await fetch(`/api/play/${item.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restart }),
  });
}

function paintPreview(thumbnail) {
  if (thumbnail) {
    dockPreview.src = thumbnail;
    dockPreviewWrap.classList.remove("hidden");
  } else {
    dockPreviewWrap.classList.add("hidden");
    dockPreview.removeAttribute("src");
  }
}

async function control(action) {
  return fetch(`/api/control/${action}`, { method: "POST" }).then((r) => r.json());
}

function setPauseIcon(paused) {
  btnPause.textContent = paused ? "▶" : "❚❚";
  btnPause.title = paused ? "Play" : "Pause";
}

btnPause.addEventListener("click", async () => {
  const res = await control("pause");
  if (res && typeof res.paused === "boolean") {
    setPauseIcon(res.paused);
  }
});
btnSeekBack.addEventListener("click", () => control("seek_backward"));
btnSeekFwd.addEventListener("click", () => control("seek_forward"));
btnFrameBack.addEventListener("click", async () => {
  const res = await control("frame_backward");
  setPauseIcon(true); // frame-stepping always leaves mpv paused
  if (res && res.frame_number != null) paintFrameCounter(res.frame_number);
});
btnFrameFwd.addEventListener("click", async () => {
  const res = await control("frame_forward");
  setPauseIcon(true);
  if (res && res.frame_number != null) paintFrameCounter(res.frame_number);
});
document.getElementById("btnStop").addEventListener("click", async () => {
  await control("stop");
  dock.classList.add("hidden");
  setTimeout(loadMedia, 600);
});

rescanBtn.addEventListener("click", async () => {
  rescanBtn.textContent = "Scanning…";
  await fetch("/api/rescan", { method: "POST" });
  await loadMedia();
  rescanBtn.textContent = "Rescan";
});

// -------------------------------------------------------- output toggle ---

function paintOutputToggle(mode, ndiBinaryFound) {
  outputHdmiBtn.classList.toggle("active", mode === "hdmi");
  outputNdiBtn.classList.toggle("active", mode === "ndi");
  outputNdiWarn.classList.toggle("hidden", ndiBinaryFound !== false);
}

async function loadOutputMode() {
  const res = await fetch("/api/output_mode");
  const data = await res.json();
  paintOutputToggle(data.mode, data.ndi_binary_found);
  outputToggle.classList.toggle("hidden", !data.switchable);
  return data.mode;
}

async function switchOutputMode(mode) {
  if (outputHdmiBtn.classList.contains("active") && mode === "hdmi") return;
  if (outputNdiBtn.classList.contains("active") && mode === "ndi") return;

  const somethingPlaying = !dock.classList.contains("hidden");
  if (somethingPlaying) {
    const ok = confirm(`Switching to ${mode.toUpperCase()} output will stop what's currently playing. Continue?`);
    if (!ok) return;
  }

  const res = await fetch("/api/output_mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const data = await res.json();
  paintOutputToggle(data.mode, data.ndi_binary_found);
  dock.classList.add("hidden");
  loadMedia(); // refresh continue-watching in case a position was just saved
}

outputHdmiBtn.addEventListener("click", () => switchOutputMode("hdmi"));
outputNdiBtn.addEventListener("click", () => switchOutputMode("ndi"));

// ------------------------------------------------------- scrub bar drag ---

let knownDuration = 0;
let scrubbing = false;

function fracFromEvent(e) {
  const rect = dockBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const frac = (clientX - rect.left) / rect.width;
  return Math.min(1, Math.max(0, frac));
}

function paintBar(frac) {
  dockBarFill.style.width = `${frac * 100}%`;
  dockBarHandle.style.left = `${frac * 100}%`;
}

async function seekToFraction(frac) {
  if (!knownDuration) return;
  await fetch("/api/seek_to", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds: knownDuration * frac }),
  });
}

function startScrub(e) {
  if (!knownDuration) return;
  scrubbing = true;
  const frac = fracFromEvent(e);
  paintBar(frac);
  dockPos.textContent = fmtTime(knownDuration * frac);
}
function moveScrub(e) {
  if (!scrubbing) return;
  const frac = fracFromEvent(e);
  paintBar(frac);
  dockPos.textContent = fmtTime(knownDuration * frac);
}
async function endScrub(e) {
  if (!scrubbing) return;
  scrubbing = false;
  const frac = fracFromEvent(e);
  await seekToFraction(frac);
}

dockBar.addEventListener("mousedown", startScrub);
window.addEventListener("mousemove", moveScrub);
window.addEventListener("mouseup", endScrub);
dockBar.addEventListener("touchstart", startScrub, { passive: true });
window.addEventListener("touchmove", moveScrub, { passive: true });
window.addEventListener("touchend", endScrub);

// ----------------------------------------------------------- status poll ---

let wasPlaying = false;

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    if (s.playing) {
      wasPlaying = true;
      dock.classList.remove("hidden");
      knownDuration = s.duration || 0;
      setPauseIcon(!!s.paused);
      if (!scrubbing) {
        dockPos.textContent = fmtTime(s.position);
        const pct = s.duration ? Math.min(1, s.position / s.duration) : 0;
        paintBar(pct);
      }
      dockDur.textContent = fmtTime(s.duration);
      dockNdiBadge.classList.toggle("hidden", s.output !== "ndi");
      dockTitle.textContent = s.title || dockTitle.textContent;
      dockDescription.textContent = s.description || "";
      dockDescription.classList.toggle("hidden", !s.description);
      if (s.thumbnail && dockPreview.getAttribute("src") !== s.thumbnail) {
        // only worth repainting when it actually changes (e.g. a second
        // client just loaded the page mid-playback) — it's a static image,
        // not something that needs refreshing every poll tick
        paintPreview(s.thumbnail);
      }
      if (s.is_sequence !== (currentFrameCount != null)) {
        // mode changed since our last paint (e.g. a second client just
        // loaded the page mid-playback) — bring the controls into sync
        setSequenceMode(!!s.is_sequence, s.frame_count, s.frame_number);
      } else if (s.is_sequence) {
        paintFrameCounter(s.frame_number);
      }
    } else {
      dock.classList.add("hidden");
      paintPreview(null);
      if (wasPlaying) {
        wasPlaying = false;
        loadMedia();
      }
    }
  } catch (e) {
    // Pi may be mid-restart of mpv; ignore transient errors
  }
}

loadMedia();
loadOutputMode();
setInterval(pollStatus, 1000);
