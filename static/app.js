// ---------------------------------------------------------------- DOM refs
const topbarScreensaverTag = document.getElementById("screensaverTag");
const settingsBtn = document.getElementById("settingsBtn");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsScrim = document.getElementById("settingsScrim");
const settingsDrawer = document.getElementById("settingsDrawer");
const screensaverOnBtn = document.getElementById("screensaverOnBtn");
const screensaverOffBtn = document.getElementById("screensaverOffBtn");
const rescanBtn = document.getElementById("rescanBtn");

const heroSection = document.getElementById("heroSection");
const heroImg = document.getElementById("heroImg");
const heroCategory = document.getElementById("heroCategory");
const heroTitle = document.getElementById("heroTitle");
const heroDesc = document.getElementById("heroDesc");
const heroPlayBtn = document.getElementById("heroPlayBtn");

const emptyEl = document.getElementById("empty");
const continueRow = document.getElementById("continueRow");
const continueGrid = document.getElementById("continueGrid");
const categoryRows = document.getElementById("categoryRows");

const dock = document.getElementById("dock");
const dockPreviewWrap = document.getElementById("dockPreviewWrap");
const dockPreview = document.getElementById("dockPreview");
const playerStopBtn = document.getElementById("playerStopBtn");
const setHeroBtn = document.getElementById("setHeroBtn");
const loopBtn = document.getElementById("loopBtn");
const playerTitle = document.getElementById("playerTitle");
const playerDesc = document.getElementById("playerDesc");
const frameCounter = document.getElementById("frameCounter");
const playerScrubControls = document.getElementById("playerScrubControls");
const playerPos = document.getElementById("playerPos");
const playerDur = document.getElementById("playerDur");
const scrubBar = document.getElementById("scrubBar");
const scrubFill = document.getElementById("scrubFill");
const scrubHandle = document.getElementById("scrubHandle");
const seekBackBtn = document.getElementById("seekBackBtn");
const seekFwdBtn = document.getElementById("seekFwdBtn");
const pauseBtn = document.getElementById("pauseBtn");
const iconPlay = document.getElementById("iconPlay");
const iconPause = document.getElementById("iconPause");

// ------------------------------------------------------------- utilities

function fmtTime(s) {
  if (s == null || isNaN(s)) return "0:00";
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function setPauseIcon(paused) {
  iconPlay.classList.toggle("hidden", !paused);
  iconPause.classList.toggle("hidden", paused);
  pauseBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
}

// ------------------------------------------------------------- row cards

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
    fill.style.width = `${Math.min(100, (item.progress.position / item.progress.duration) * 100)}%`;
    bar.appendChild(fill);
    thumbWrap.appendChild(bar);
  }

  const title = document.createElement("div");
  title.className = "card__title";
  title.textContent = item.title;
  thumbWrap.appendChild(title);

  card.appendChild(thumbWrap);
  card.addEventListener("click", () => playItem(item));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playItem(item); }
  });
  return card;
}

let allMediaItems = [];

function renderCategories(items) {
  categoryRows.innerHTML = "";
  const byCategory = new Map();
  for (const item of items) {
    const cat = item.category || "Uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(item);
  }
  const names = [...byCategory.keys()];
  const onlyFlat = names.length === 1 && names[0] === "Uncategorized";
  const sortedNames = onlyFlat
    ? names
    : names.sort((a, b) => {
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
    for (const item of byCategory.get(name)) scroller.appendChild(buildCard(item));
    section.appendChild(scroller);
    wrapScroller(scroller);

    categoryRows.appendChild(section);
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
  return items;
}

// ------------------------------------------------------------------ hero

function paintHero(item, heroThumbnail) {
  if (!item) {
    heroSection.classList.add("hidden");
    return;
  }
  heroSection.classList.remove("hidden");
  const src = heroThumbnail || item.thumbnail;
  if (src) heroImg.src = src;
  heroCategory.textContent = item.category || "";
  heroTitle.textContent = item.title;
  heroDesc.textContent = item.description || "";
  heroDesc.classList.toggle("hidden", !item.description);
  heroPlayBtn.onclick = () => playItem(item);
}

function pickHero(continueItems, allItems, explicitHeroId) {
  if (explicitHeroId) {
    const pinned = allItems.find((i) => i.id === explicitHeroId);
    if (pinned) return pinned;
  }
  if (continueItems.length > 0) return continueItems[0];
  if (allItems.length > 0) return allItems[0];
  return null;
}

// --------------------------------------------------------------- loading

let pinnedHeroId = null;
let pinnedHeroThumbnail = null;
let lastContinueItems = [];

function paintHeroFromPick(continueItems, items) {
  const picked = pickHero(continueItems, items, pinnedHeroId);
  const heroThumb = picked && picked.id === pinnedHeroId ? pinnedHeroThumbnail : null;
  paintHero(picked, heroThumb);
}

async function loadMedia() {
  const [mediaRes, continueRes] = await Promise.all([
    fetch("/api/media"),
    fetch("/api/continue-watching"),
  ]);
  const items = await mediaRes.json();
  const continueItems = await continueRes.json();

  allMediaItems = items;
  lastContinueItems = continueItems;
  emptyEl.classList.toggle("hidden", items.length > 0);
  renderCategories(items);
  renderContinueRow(continueItems);
  paintHeroFromPick(continueItems, items);
  paintSetHeroBtn();
}

async function loadHeroPreference() {
  const res = await fetch("/api/hero");
  const data = await res.json();
  pinnedHeroId = data.id || null;
  pinnedHeroThumbnail = data.hero_thumbnail || null;
}

function paintSetHeroBtn() {
  const isPinned = !!currentPlayingId && currentPlayingId === pinnedHeroId;
  setHeroBtn.classList.toggle("active", isPinned);
  setHeroBtn.title = isPinned
    ? "Unset as hero video (back to automatic pick)"
    : "Set as hero video";
}

setHeroBtn.addEventListener("click", async () => {
  if (!currentPlayingId) return;
  const nextId = pinnedHeroId === currentPlayingId ? null : currentPlayingId;
  if (nextId !== null) {
    const ok = confirm(`Set "${playerTitle.textContent}" as the featured hero video?`);
    if (!ok) return;
  }
  const res = await fetch("/api/hero", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: nextId }),
  });
  const data = await res.json();
  pinnedHeroId = data.id || null;
  pinnedHeroThumbnail = data.hero_thumbnail || null;
  paintSetHeroBtn();
  // repaint the hero banner immediately using the freshest pick, without
  // needing a full reload
  paintHeroFromPick(lastContinueItems, allMediaItems);
});

// -------------------------------------------------------------- settings

function openSettings() {
  settingsScrim.classList.remove("hidden");
  settingsDrawer.classList.remove("hidden");
}
function closeSettings() {
  settingsScrim.classList.add("hidden");
  settingsDrawer.classList.add("hidden");
}
settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", closeSettings);
settingsScrim.addEventListener("click", closeSettings);

function paintScreensaverToggle(enabled) {
  screensaverOnBtn.classList.toggle("active", enabled);
  screensaverOffBtn.classList.toggle("active", !enabled);
  topbarScreensaverTag.classList.toggle("hidden", !enabled);
}
async function loadScreensaverState() {
  const res = await fetch("/api/screensaver");
  const data = await res.json();
  paintScreensaverToggle(data.enabled);
}
async function setScreensaver(enabled) {
  const res = await fetch("/api/screensaver", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json();
  paintScreensaverToggle(data.enabled);
}
screensaverOnBtn.addEventListener("click", () => setScreensaver(true));
screensaverOffBtn.addEventListener("click", () => setScreensaver(false));

rescanBtn.addEventListener("click", async () => {
  rescanBtn.textContent = "Scanning…";
  await fetch("/api/rescan", { method: "POST" });
  await loadMedia();
  rescanBtn.textContent = "Rescan library";
});

// ----------------------------------------------------------------------
// Sequence (frame-step) mode

let currentFrameCount = null;

function setSequenceMode(isSequence, frameCount, frameNumber) {
  currentFrameCount = isSequence ? frameCount : null;
  playerScrubControls.classList.toggle("hidden", isSequence);
  frameCounter.classList.toggle("hidden", !isSequence);
  if (isSequence) paintFrameCounter(frameNumber);
}

function paintFrameCounter(frameNumber) {
  const shown = frameNumber != null ? frameNumber + 1 : "—";
  const total = currentFrameCount != null ? currentFrameCount : "—";
  frameCounter.textContent = `Frame ${shown} of ${total}`;
}

// ----------------------------------------------------------------------
// Player (full-screen "now playing")

function paintPreview(thumbnail) {
  if (thumbnail) {
    dockPreview.src = thumbnail;
    dockPreviewWrap.classList.remove("hidden");
  } else {
    dockPreviewWrap.classList.add("hidden");
    dockPreview.removeAttribute("src");
  }
}

let currentPlayingId = null;

async function playItem(item, { restart = false } = {}) {
  currentPlayingId = item.id;
  playerTitle.textContent = item.title;
  playerDesc.textContent = item.description || "";
  playerDesc.classList.toggle("hidden", !item.description);
  paintPreview(item.thumbnail);
  setSequenceMode(!!item.is_sequence, item.frame_count, 0);
  setPauseIcon(false);
  paintSetHeroBtn();
  dock.classList.remove("hidden");

  await fetch(`/api/play/${item.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restart }),
  });
}

function hideDock() {
  dock.classList.add("hidden");
  paintPreview(null);
  currentPlayingId = null;
}

async function stopPlayback() {
  await control("stop");
  hideDock();
  setTimeout(loadMedia, 600);
}

playerStopBtn.addEventListener("click", stopPlayback);

async function control(action) {
  return fetch(`/api/control/${action}`, { method: "POST" }).then((r) => r.json());
}

pauseBtn.addEventListener("click", async () => {
  const res = await control("pause");
  if (res && typeof res.paused === "boolean") setPauseIcon(res.paused);
});
seekBackBtn.addEventListener("click", async () => {
  const res = await control("seek_backward");
  setPauseIcon(true);
  if (res && res.frame_number != null) paintFrameCounter(res.frame_number);
});
seekFwdBtn.addEventListener("click", async () => {
  const res = await control("seek_forward");
  setPauseIcon(true);
  if (res && res.frame_number != null) paintFrameCounter(res.frame_number);
});

function paintLoopBtn(looping) {
  loopBtn.classList.toggle("active", !!looping);
}
loopBtn.addEventListener("click", async () => {
  const res = await control("loop");
  if (res && typeof res.looping === "boolean") paintLoopBtn(res.looping);
});

// scrub bar drag
let knownDuration = 0;
let scrubbing = false;
function fracFromEvent(e) {
  const rect = scrubBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}
function paintScrub(frac) {
  scrubFill.style.width = `${frac * 100}%`;
  scrubHandle.style.left = `${frac * 100}%`;
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
  paintScrub(frac);
  playerPos.textContent = fmtTime(knownDuration * frac);
}
function moveScrub(e) {
  if (!scrubbing) return;
  const frac = fracFromEvent(e);
  paintScrub(frac);
  playerPos.textContent = fmtTime(knownDuration * frac);
}
async function endScrub(e) {
  if (!scrubbing) return;
  scrubbing = false;
  await seekToFraction(fracFromEvent(e));
}
scrubBar.addEventListener("mousedown", startScrub);
window.addEventListener("mousemove", moveScrub);
window.addEventListener("mouseup", endScrub);
scrubBar.addEventListener("touchstart", startScrub, { passive: true });
window.addEventListener("touchmove", moveScrub, { passive: true });
window.addEventListener("touchend", endScrub);

// ----------------------------------------------------------------------
// Status polling — keeps the player in sync (including a fresh pageload
// or a second browser tab catching mid-playback), and detects natural end.

let wasPlaying = false;

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    if (s.playing) {
      wasPlaying = true;
      if (dock.classList.contains("hidden")) {
        // something's playing that this client didn't initiate (fresh
        // pageload, or another tab pressed play) — show the dock to match
        dock.classList.remove("hidden");
      }
      if (s.id && s.id !== currentPlayingId) {
        currentPlayingId = s.id;
        paintSetHeroBtn();
      }
      playerTitle.textContent = s.title || playerTitle.textContent;
      playerDesc.textContent = s.description || "";
      playerDesc.classList.toggle("hidden", !s.description);
      if (s.thumbnail && dockPreview.getAttribute("src") !== s.thumbnail) {
        paintPreview(s.thumbnail);
      }
      setPauseIcon(!!s.paused);
      paintLoopBtn(!!s.looping);

      if (s.is_sequence !== (currentFrameCount != null)) {
        setSequenceMode(!!s.is_sequence, s.frame_count, s.frame_number);
      } else if (s.is_sequence) {
        paintFrameCounter(s.frame_number);
      } else {
        knownDuration = s.duration || 0;
        if (!scrubbing) {
          playerPos.textContent = fmtTime(s.position);
          paintScrub(s.duration ? Math.min(1, s.position / s.duration) : 0);
        }
        playerDur.textContent = fmtTime(s.duration);
      }
    } else {
      if (wasPlaying) {
        wasPlaying = false;
        hideDock();
        loadMedia();
      }
    }
  } catch (e) {
    // Pi may be mid-restart of mpv; ignore transient errors
  }
}

(async () => {
  await loadHeroPreference();
  await loadMedia();
  loadScreensaverState();
  setInterval(pollStatus, 1000);
})();
