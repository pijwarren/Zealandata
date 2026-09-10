// ---------------------------------------------------------------- DOM refs
const topbar = document.getElementById("topbar");
const startScreensaverBtn = document.getElementById("startScreensaverBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsScrim = document.getElementById("settingsScrim");
const settingsDrawer = document.getElementById("settingsDrawer");
const rescanBtn = document.getElementById("rescanBtn");
const screensaverToggleBtn = document.getElementById("screensaverToggleBtn");
const adminModeBtn = document.getElementById("adminModeBtn");
const changePinField = document.getElementById("changePinField");
const changePinBtn = document.getElementById("changePinBtn");
const changePinStatus = document.getElementById("changePinStatus");
const uploadCategorySelect = document.getElementById("uploadCategorySelect");
const uploadNewCategory = document.getElementById("uploadNewCategory");
const uploadInput = document.getElementById("uploadInput");
const uploadChooseBtn = document.getElementById("uploadChooseBtn");
const uploadAttachmentsInput = document.getElementById("uploadAttachmentsInput");
const uploadAttachmentsChooseBtn = document.getElementById("uploadAttachmentsChooseBtn");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const playTrackingBtn = document.getElementById("playTrackingBtn");
const popularVisibilityBtn = document.getElementById("popularVisibilityBtn");
const previewField = document.getElementById("previewField");
const previewToggleBtn = document.getElementById("previewToggleBtn");
const previewGizmoBtn = document.getElementById("previewGizmoBtn");
const libraryField = document.getElementById("libraryField");
const mappingField = document.getElementById("mappingField");
const mappingShadingBtn = document.getElementById("mappingShadingBtn");
const mappingFpsBtn = document.getElementById("mappingFpsBtn");
const mappingFlipHBtn = document.getElementById("mappingFlipHBtn");
const mappingFlipVBtn = document.getElementById("mappingFlipVBtn");
const mappingGridcheckBtn = document.getElementById("mappingGridcheckBtn");
const mappingResetBtn = document.getElementById("mappingResetBtn");
const thumbnailRerenderBtn = document.getElementById("thumbnailRerenderBtn");
const thumbnailViewNote = document.getElementById("thumbnailViewNote");
const thumbnailRerenderStatus = document.getElementById("thumbnailRerenderStatus");
const pinScrim = document.getElementById("pinScrim");
const pinModal = document.getElementById("pinModal");
const pinTitle = document.getElementById("pinTitle");
const pinDots = document.getElementById("pinDots");
const pinError = document.getElementById("pinError");
const pinCancelBtn = document.getElementById("pinCancelBtn");
const pinBackBtn = document.getElementById("pinBackBtn");

const heroSection = document.getElementById("heroSection");
const heroImg = document.getElementById("heroImg");
const heroCategory = document.getElementById("heroCategory");
const heroTitle = document.getElementById("heroTitle");
const heroDesc = document.getElementById("heroDesc");
const heroPlayBtn = document.getElementById("heroPlayBtn");

const emptyEl = document.getElementById("empty");
const continueRow = document.getElementById("continueRow");
const continueGrid = document.getElementById("continueGrid");
const popularRow = document.getElementById("popularRow");
const popularGrid = document.getElementById("popularGrid");
const categoryRows = document.getElementById("categoryRows");
const categoryNav = document.getElementById("categoryNav");

const dockPreviewWrap = document.getElementById("dockPreviewWrap");
const dockPreview = document.getElementById("dockPreview");
const dockDocs = document.getElementById("dockDocs");
const docScrim = document.getElementById("docScrim");
const docViewer = document.getElementById("docViewer");
const docViewerClose = document.getElementById("docViewerClose");
const docViewerContent = document.getElementById("docViewerContent");
const docViewerPrev = document.getElementById("docViewerPrev");
const docViewerNext = document.getElementById("docViewerNext");
const docViewerCounter = document.getElementById("docViewerCounter");
const playerStopBtn = document.getElementById("playerStopBtn");
const setHeroBtn = document.getElementById("setHeroBtn");
const loopBtn = document.getElementById("loopBtn");
const playerTitle = document.getElementById("playerTitle");
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

  // Same .chevron the keystone nudges and the projector's own corner marker
  // use -- see style.css -- rather than an angle-quote glyph of its own.
  const chevron = (dir) => {
    const span = document.createElement("span");
    span.className = `chevron chevron--${dir}`;
    return span;
  };

  const leftBtn = document.createElement("button");
  leftBtn.className = "row__arrow row__arrow--left hidden";
  leftBtn.setAttribute("aria-label", "Scroll left");
  leftBtn.appendChild(chevron("left"));

  const rightBtn = document.createElement("button");
  rightBtn.className = "row__arrow row__arrow--right hidden";
  rightBtn.setAttribute("aria-label", "Scroll right");
  rightBtn.appendChild(chevron("right"));

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
const popularScrollUpdate = wrapScroller(popularGrid);

// A card must be clicked once to select it (arms the play glyph and takes
// over the hero area with a high-res preview + its description), and
// clicked again to actually play -- avoids accidentally launching playback
// with a stray touch/click while browsing, and lets you click through
// several posters to read about them before picking one. Selecting a
// different card swaps the preview straight to it; clicking outside all
// cards clears the selection and reverts the hero back to its normal pick.
let selectedCard = null;
let previewedItem = null;

function paintCardUnselected(card) {
  card.classList.remove("card--selected");
  card.setAttribute("aria-label", card.dataset.title ? `Select ${card.dataset.title}` : "Select");
}

// Only unstyles the card -- leaves the hero preview showing (used when a
// selection resolves into actually playing, so the hero doesn't flash back
// to the default pick right as that item starts).
function unselectCardOnly() {
  if (!selectedCard) return;
  paintCardUnselected(selectedCard);
  selectedCard = null;
}

function clearSelection() {
  unselectCardOnly();
  if (previewedItem) {
    previewedItem = null;
    paintHeroFromPick(lastContinueItems, allMediaItems);
  }
}

async function showHeroPreview(item) {
  previewedItem = item;
  paintHero(item, item.thumbnail); // immediate, low-res -- upgraded below once ready
  try {
    const res = await fetch(`/api/media/${item.id}/preview`);
    const data = await res.json();
    if (previewedItem !== item || !data.hero_thumbnail) return; // superseded, or none generated
    heroImg.src = data.hero_thumbnail;
  } catch (e) {
    // stay on the low-res thumbnail already painted above
  }
}

document.addEventListener("click", (e) => {
  if (selectedCard && !selectedCard.contains(e.target)) clearSelection();
});

// A non-interactive placeholder card appended to the end of every category
// row, since each category is still filling out -- not tied to any real
// item, so it's built separately from buildCard rather than shoehorned in.
function buildComingSoonCard() {
  const card = document.createElement("div");
  card.className = "card card--coming-soon";
  const label = document.createElement("div");
  label.className = "card__coming-soon-label";
  label.textContent = "More coming soon";
  card.appendChild(label);
  return card;
}

function buildCard(item, { badge, showRestart, isContinueRow } = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.title = item.title;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Select ${item.title}`);

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

  const topRight = document.createElement("div");
  topRight.className = "card__top-right";
  if (badge) {
    const b = document.createElement("div");
    b.className = "card__resume-badge";
    b.textContent = badge;
    topRight.appendChild(b);
  }
  const rename = document.createElement("button");
  rename.className = "card__rename";
  rename.title = "Rename";
  rename.setAttribute("aria-label", `Rename ${item.title}`);
  rename.textContent = "✎";
  rename.addEventListener("click", (e) => {
    e.stopPropagation();
    renameMedia(item);
  });
  topRight.appendChild(rename);
  thumbWrap.appendChild(topRight);

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

  const activate = () => {
    if (selectedCard === card) {
      // Resuming is only for the Continue Watching row -- every other
      // selection (regular browse grid, hero) starts from the beginning,
      // even if the video happens to have saved progress (but without
      // touching that saved progress -- see the explicit ↺ restart
      // button below for the "forget where I was" action).
      playItem(item, { resume: isContinueRow }); // clears the armed selection itself
      return;
    }
    if (selectedCard) paintCardUnselected(selectedCard); // switching -- no hero flash in between
    selectedCard = card;
    card.classList.add("card--selected");
    card.setAttribute("aria-label", `Play ${item.title}`);
    showHeroPreview(item);
  };
  card.addEventListener("click", activate);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
  });
  return card;
}

let allMediaItems = [];

// Wordmark placeholders for this library's fixed 6 categories (real icons
// TBD) -- jumps to that category's row when clicked, regardless of scroll
// position. Built once; renderCategories() below just toggles which ones
// currently have any content, since not every category necessarily has
// videos in it yet.
const CATEGORY_NAV_NAMES = [
  "Geological Hazards",
  "Weather and Climate Hazards",
  "Atmosphere and Climate",
  "Land and Water",
  "Oceans and Fisheries",
  "Energy",
];
for (const name of CATEGORY_NAV_NAMES) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "category-nav__item";
  btn.textContent = name.replace(/\band\b/gi, "&");
  btn.dataset.categoryName = name;
  btn.addEventListener("click", () => {
    const section = categoryRows.querySelector(`section[aria-label="${CSS.escape(name)}"]`);
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  categoryNav.appendChild(btn);
}

function renderCategories(items) {
  selectedCard = null; // about to be torn down along with the old cards
  previewedItem = null; // loadMedia() repaints the hero right after this anyway
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
    heading.textContent = onlyFlat ? "Library" : name.replace(/\band\b/gi, "&");
    section.appendChild(heading);

    const scroller = document.createElement("div");
    scroller.className = "row__scroller";
    for (const item of byCategory.get(name)) scroller.appendChild(buildCard(item));
    scroller.appendChild(buildComingSoonCard());
    section.appendChild(scroller);
    wrapScroller(scroller);

    categoryRows.appendChild(section);
  }

  for (const btn of categoryNav.children) {
    btn.classList.toggle("category-nav__item--empty", !sortedNames.includes(btn.dataset.categoryName));
  }
}

function renderContinueRow(items) {
  continueGrid.innerHTML = "";
  continueRow.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const remaining = item.progress.duration - item.progress.position;
    const badge = remaining > 60 ? `${fmtTime(remaining)} left` : "Almost done";
    continueGrid.appendChild(buildCard(item, { badge, showRestart: true, isContinueRow: true }));
  }
  continueScrollUpdate();
  return items;
}

function renderPopularRow(items) {
  popularGrid.innerHTML = "";
  popularRow.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const badge = `${item.play_count} play${item.play_count === 1 ? "" : "s"}`;
    popularGrid.appendChild(buildCard(item, { badge }));
  }
  popularScrollUpdate();
  return items;
}

// ------------------------------------------------------------------ hero

function paintHero(item, heroThumbnail) {
  if (!item) {
    heroSection.classList.add("hidden");
    return;
  }
  heroSection.classList.remove("hidden");
  // The strip is unmeasurable while the hero is display:none, so take the
  // reading now it has one. (ResizeObserver catches this too where it
  // exists; this covers the browsers where it doesn't.)
  syncStickyOffsets();
  const src = heroThumbnail || item.thumbnail;
  if (src) heroImg.src = src;
  heroCategory.textContent = item.category || "";
  heroTitle.textContent = item.title;
  heroDesc.textContent = item.description || "";
  heroDesc.classList.toggle("hidden", !item.description);
  // The hero is a browsing spotlight, not the Continue Watching row itself
  // -- even when it happens to be showing your top in-progress pick --
  // so its Play button always starts from the beginning, same as any
  // other non-Continue-Watching selection (without resume, saved
  // progress for it is simply left alone rather than cleared).
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
  const [mediaRes, continueRes, popularRes] = await Promise.all([
    fetch("/api/media"),
    fetch("/api/continue-watching"),
    fetch("/api/most-popular"),
  ]);
  const items = await mediaRes.json();
  const continueItems = await continueRes.json();
  const popularItems = await popularRes.json();

  allMediaItems = items;
  lastContinueItems = continueItems;
  emptyEl.classList.toggle("hidden", items.length > 0);
  renderCategories(items);
  renderContinueRow(continueItems);
  renderPopularRow(popularItems);
  paintHeroFromPick(continueItems, items);
  paintSetHeroBtn();
  paintUploadCategories();
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

// ------------------------------------------------------- auto-hiding topbar

// Slides the top bar out of view on scroll-down, back in on scroll-up --
// ignores tiny jitter (a few px either way) and never hides near the very
// top of the page, so it doesn't flicker away right as you start scrolling.
let lastScrollY = window.scrollY;

// The hero pins its category strip below the top bar, so it needs to know
// when that bar is there -- mirrored onto <body> because the strip is
// styled from a rule that can't reach across to .topbar's own class.
function setTopbarHidden(hidden) {
  topbar.classList.toggle("topbar--hidden", hidden);
  document.body.classList.toggle("topbar-hidden", hidden);
}

window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const delta = y - lastScrollY;
  if (y < 80) {
    setTopbarHidden(false);
  } else if (delta > 8) {
    setTopbarHidden(true);
  } else if (delta < -8) {
    setTopbarHidden(false);
  }
  lastScrollY = y;
}, { passive: true });

// Both offsets the hero's sticky position is built from (see style.css's
// .hero) depend on how their own content wraps -- the category labels
// shrink and rewrap with the viewport, and the bar's height follows its
// buttons -- so they're measured rather than guessed. Without this the
// strip parks a few pixels high or low and either clips its own buttons
// or leaves a sliver of hero showing above them.
function syncStickyOffsets() {
  const nav = categoryNav.offsetHeight;
  const bar = topbar.offsetHeight;
  if (nav) document.documentElement.style.setProperty("--category-nav-h", nav + "px");
  if (bar) document.documentElement.style.setProperty("--topbar-h", bar + "px");
}
if (typeof ResizeObserver !== "undefined") {
  const stickyObserver = new ResizeObserver(syncStickyOffsets);
  stickyObserver.observe(categoryNav);
  stickyObserver.observe(topbar);
}
window.addEventListener("resize", syncStickyOffsets, { passive: true });

// ------------------------------------------------------------- overlays

// Shared open/close for the glass scrim+panel pairs (settings drawer, PIN
// pad, doc viewer). `hidden` still removes a closed overlay from
// layout/hit-testing, but the class flip is sequenced around the
// `.is-open` transition (see style.css) so the surface materializes --
// fades and settles from a slight scale -- instead of popping instantly.
const OVERLAY_TRANSITION_MS = 200;
function openOverlay(scrimEl, panelEl) {
  scrimEl.classList.remove("hidden");
  panelEl.classList.remove("hidden");
  // Force layout so the browser paints the closed state for one frame
  // before is-open lands -- otherwise both class changes land in the same
  // frame and there's nothing for the transition to animate from.
  void panelEl.offsetWidth;
  scrimEl.classList.add("is-open");
  panelEl.classList.add("is-open");
}
function closeOverlay(scrimEl, panelEl, onClosed) {
  scrimEl.classList.remove("is-open");
  panelEl.classList.remove("is-open");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    scrimEl.classList.add("hidden");
    panelEl.classList.add("hidden");
    if (onClosed) onClosed();
  };
  panelEl.addEventListener("transitionend", finish, { once: true });
  // Safety net: reduced-motion or a dropped transitionend shouldn't leave
  // the overlay's content (e.g. the doc viewer's iframe) alive forever.
  setTimeout(finish, OVERLAY_TRANSITION_MS + 100);
}

// -------------------------------------------------------------- settings

// The drawer scrolls its own contents, so the page behind it is locked
// while it's open -- otherwise a scroll that ran past the end of the
// drawer, or one made with the pointer over the scrim, moved the whole
// library underneath. See style.css's .scroll-locked, which is set on
// <html> because that's what actually scrolls here. Kept locked through
// the close animation too, or the page behind would jump into view before
// the drawer has finished fading out.
function openSettings() {
  document.documentElement.classList.add("scroll-locked");
  openOverlay(settingsScrim, settingsDrawer);
}
function closeSettings() {
  closeOverlay(settingsScrim, settingsDrawer, () => {
    document.documentElement.classList.remove("scroll-locked");
  });
}
settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", closeSettings);
settingsScrim.addEventListener("click", closeSettings);

let screensaverEnabled = false;

function paintScreensaverToggle(enabled) {
  screensaverEnabled = enabled;
  screensaverToggleBtn.textContent = enabled ? "Turn off screensaver" : "Turn on screensaver";
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
screensaverToggleBtn.addEventListener("click", () => setScreensaver(!screensaverEnabled));

startScreensaverBtn.addEventListener("click", async () => {
  startScreensaverBtn.disabled = true;
  try {
    const res = await fetch("/api/screensaver/start", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (typeof data.enabled === "boolean") paintScreensaverToggle(data.enabled);
    paintDockIdle(); // next pollStatus tick fills in the actual pick's title
  } finally {
    startScreensaverBtn.disabled = false;
  }
});

rescanBtn.addEventListener("click", async () => {
  rescanBtn.textContent = "Scanning…";
  await fetch("/api/rescan", { method: "POST" });
  await loadMedia();
  rescanBtn.textContent = "Rescan library";
});

// ----------------------------------------------------------------------
// PIN pad (used to unlock admin mode)

let pinEntry = "";
let pinVerify = null;   // async (candidatePin) => boolean, set per openPinPad() call
let pinResolve = null;  // resolves the promise returned by openPinPad()
let pinChecking = false;

function paintPinDots() {
  [...pinDots.children].forEach((dot, i) => {
    dot.classList.toggle("pinpad__dot--filled", i < pinEntry.length);
  });
}

// Opens the PIN pad and resolves with the correct PIN string once
// verifyFn(candidate) returns true, or with null if the user cancels.
// The modal stays open and shakes on a wrong guess rather than closing,
// so retrying doesn't mean reopening it.
function openPinPad(title, verifyFn) {
  return new Promise((resolve) => {
    pinEntry = "";
    pinChecking = false;
    pinVerify = verifyFn;
    pinResolve = resolve;
    pinTitle.textContent = title;
    pinError.classList.add("hidden");
    paintPinDots();
    openOverlay(pinScrim, pinModal);
  });
}

function closePinPad(result) {
  closeOverlay(pinScrim, pinModal, () => {
    const resolve = pinResolve;
    pinResolve = null;
    pinVerify = null;
    if (resolve) resolve(result);
  });
}

function pinPadFail(message) {
  pinError.textContent = message || "Incorrect PIN";
  pinError.classList.remove("hidden");
  pinModal.classList.add("pinpad--shake");
  setTimeout(() => pinModal.classList.remove("pinpad--shake"), 400);
  pinEntry = "";
  paintPinDots();
}

async function pinDigit(d) {
  if (pinChecking || pinEntry.length >= 4) return;
  pinEntry += d;
  paintPinDots();
  if (pinEntry.length < 4) return;
  pinChecking = true;
  const candidate = pinEntry;
  // verifyFn returns { ok, message? } -- a plain "true" is treated as a
  // no-verification success (unused today, but keeps openPinPad generic).
  const result = pinVerify ? await pinVerify(candidate) : { ok: true };
  pinChecking = false;
  if (result.ok) closePinPad(candidate);
  else pinPadFail(result.message);
}

pinModal.querySelectorAll(".pinpad__key[data-digit]").forEach((btn) => {
  btn.addEventListener("click", () => pinDigit(btn.dataset.digit));
});
pinBackBtn.addEventListener("click", () => {
  pinEntry = pinEntry.slice(0, -1);
  paintPinDots();
});
pinCancelBtn.addEventListener("click", () => closePinPad(null));
pinScrim.addEventListener("click", () => closePinPad(null));

// ----------------------------------------------------------------------
// Admin mode (PIN-gated renaming + hero selection)

// Held in memory only for this tab -- never persisted -- and sent with
// each admin request so the server independently re-checks it rather
// than trusting a client-side "unlocked" flag alone.
// A server-issued session token rather than the PIN itself (see
// server.py's ADMIN_SESSION_TTL_SECONDS): the PIN is never written to
// browser storage, and the expiry is enforced server-side where it can't
// just be edited. Restored on load, so a refresh no longer locks the panel.
const ADMIN_TOKEN_KEY = "zealandata.adminToken";
let adminToken = null;

function storeAdminToken(token) {
  adminToken = token || null;
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch (e) {
    // Private mode or storage disabled -- the session still works for this
    // tab, it just won't survive a reload.
  }
}

function paintAdminMode() {
  document.body.classList.toggle("admin-mode", !!adminToken);
  adminModeBtn.textContent = adminToken ? "Lock admin mode" : "Unlock admin mode";
  changePinField.classList.toggle("hidden", !adminToken);
  previewField.classList.toggle("hidden", !adminToken);
  // The whole Library and calibration sections, rather than each control
  // inside them -- everything they hold is admin-only, so gating them
  // individually was four ways of saying the same thing.
  libraryField.classList.toggle("hidden", !adminToken);
  mappingField.classList.toggle("hidden", !adminToken);
  if (adminToken) paintUploadCategories();
  else changePinStatus.textContent = "";
  paintSetHeroBtn();
}

// Auto-relocks admin mode after an hour with no interaction anywhere on
// the page, so it doesn't stay unlocked indefinitely on a shared/kiosk
// screen. Any click or keypress resets the clock while admin mode is on;
// the listeners themselves are always active but are no-ops (clear a timer
// that's never set) while it's off. Matches the server's own session TTL,
// which also runs from last use -- this is the local half of the same
// hour, so a tab left open and a tab closed and reopened behave the same.
const ADMIN_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let adminIdleTimer = null;

function relockAdminMode() {
  // Tell the server to drop it too, so locking actually revokes the
  // session rather than only forgetting it here. Fire-and-forget: the
  // panel locks either way, and a failed revoke still expires on its own.
  if (adminToken) {
    fetch("/api/admin/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: adminToken }),
    }).catch(() => {});
  }
  storeAdminToken(null);
  paintAdminMode();
}

function resetAdminIdleTimer() {
  if (adminIdleTimer) clearTimeout(adminIdleTimer);
  adminIdleTimer = adminToken ? setTimeout(relockAdminMode, ADMIN_IDLE_TIMEOUT_MS) : null;
}
document.addEventListener("pointerdown", resetAdminIdleTimer);
document.addEventListener("keydown", resetAdminIdleTimer);

// The PIN goes to the server exactly once, at unlock; what comes back is
// the session token everything afterwards uses. Stashed here rather than
// returned because openPinPad only reports whether the attempt passed.
let pendingAdminToken = null;

async function verifyAdminPin(candidate) {
  const res = await fetch("/api/admin/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: candidate }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    return { ok: false, message: `Too many attempts — try again in ${fmtTime(data.locked_seconds)}` };
  }
  if (data.ok && data.token) pendingAdminToken = data.token;
  return { ok: !!data.ok };
}

// Comes back unlocked after a reload when the stored session is still
// live. Checked against the server rather than trusted outright, so an
// expired or restart-dropped token falls back to locked instead of
// painting an unlocked panel whose first real request would fail.
async function restoreAdminSession() {
  let stored = null;
  try {
    stored = localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch (e) {
    return;
  }
  if (!stored) return;
  try {
    const res = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: stored }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      storeAdminToken(stored);
      paintAdminMode();
      resetAdminIdleTimer();
    } else {
      storeAdminToken(null);
    }
  } catch (e) {
    // Server unreachable -- leave it locked; a later reload can restore.
  }
}

adminModeBtn.addEventListener("click", async () => {
  if (adminToken) {
    relockAdminMode();
    resetAdminIdleTimer();
    return;
  }
  const pin = await openPinPad("Enter Admin PIN", verifyAdminPin);
  if (pin && pendingAdminToken) {
    storeAdminToken(pendingAdminToken);
    pendingAdminToken = null;
    paintAdminMode();
    resetAdminIdleTimer();
  }
});

changePinBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  changePinStatus.textContent = "";
  const newPin = await openPinPad("Enter New PIN", async () => ({ ok: true }));
  if (!newPin) return;
  const confirmPin = await openPinPad("Confirm New PIN", async (candidate) => (
    candidate === newPin ? { ok: true } : { ok: false, message: "Doesn't match — try again" }
  ));
  if (!confirmPin) return;
  const res = await fetch("/api/admin/change-pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, new_pin: confirmPin }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    changePinStatus.textContent = data.error;
    return;
  }
  // The session token survives a PIN change -- this client just proved
  // itself, and the server keeps existing sessions valid.
  resetAdminIdleTimer();
  changePinStatus.textContent = "PIN changed.";
});

// Off by default and left running server-side (not tied to any one
// client's admin session) once switched on -- see server.py's
// PLAY_TRACKING_ENABLED comment. It lives in the Library section, which
// only shows while adminToken is set (paintAdminMode above), so this button
// is only ever clickable with a live admin session already in hand.
let playTrackingEnabled = false;

function paintPlayTrackingToggle(enabled) {
  playTrackingEnabled = enabled;
  playTrackingBtn.textContent = enabled ? "Disable play tracking" : "Enable play tracking";
}
async function loadPlayTrackingState() {
  const res = await fetch("/api/play-tracking");
  const data = await res.json();
  paintPlayTrackingToggle(data.enabled);
}
playTrackingBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/play-tracking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, enabled: !playTrackingEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (typeof data.enabled === "boolean") paintPlayTrackingToggle(data.enabled);
});

// Separate from playTrackingEnabled above -- this controls whether the row
// is shown to viewers at all, independent of whether plays are currently
// being counted (see server.py's POPULAR_ROW_VISIBLE comment).
let popularRowVisible = false;

function paintPopularVisibilityToggle(enabled) {
  popularRowVisible = enabled;
  popularVisibilityBtn.textContent = enabled ? "Hide Most Popular row" : "Show Most Popular row";
}
async function loadPopularVisibilityState() {
  const res = await fetch("/api/popular-visibility");
  const data = await res.json();
  paintPopularVisibilityToggle(data.enabled);
}
popularVisibilityBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/popular-visibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, enabled: !popularRowVisible }),
  });
  const data = await res.json().catch(() => ({}));
  if (typeof data.enabled === "boolean") paintPopularVisibilityToggle(data.enabled);
  // Re-fetch and re-render right away rather than waiting for the next
  // loadMedia() cycle, so the row's visibility change shows immediately.
  const popularRes = await fetch("/api/most-popular");
  renderPopularRow(await popularRes.json());
});

// Calibrates how the video lines up with the physical 3D-printed model on
// the projection output (see server.py's RENDER_BACKEND/mapping.json) --
// only meaningful when the projector backend is active, but the controls
// stay available regardless since there's no harm in adjusting values
// that simply aren't being rendered against right now.
let mappingShadingEnabled = false;
// Unlike shading and the gizmo, this one has no counterpart in the
// client-side preview: it reports what the projection page's own render
// loop is achieving, which the preview canvas -- a different renderer on
// a different machine -- can't stand in for. So it's output-only.
let mappingFpsEnabled = false;
// Manual video orientation switches -- see server.py's MAPPING_BOOLEAN
// comment on why these are plain operator-facing controls rather than
// something computed automatically.
let mappingFlipHEnabled = false;
let mappingFlipVEnabled = false;

// Each slider is paired with a number input (typed entry) and a pair of
// +/- buttons (nudge by the slider's own step) -- driven off this table
// instead of six near-identical blocks of listener code.
const MAPPING_CONTROLS = [
  { key: "scale", range: "mappingScale", number: "mappingScaleNumber", decimals: 2 },
  { key: "throw_distance", range: "mappingThrowDistance", number: "mappingThrowDistanceNumber", decimals: 2 },
  { key: "throw_offset_x", range: "mappingThrowOffsetX", number: "mappingThrowOffsetXNumber", decimals: 2 },
  { key: "throw_offset_y", range: "mappingThrowOffsetY", number: "mappingThrowOffsetYNumber", decimals: 2 },
  { key: "rotation_x", range: "mappingRotationX", number: "mappingRotationXNumber", decimals: 0 },
  { key: "rotation_y", range: "mappingRotationY", number: "mappingRotationYNumber", decimals: 0 },
  { key: "rotation_z", range: "mappingRotationZ", number: "mappingRotationZNumber", decimals: 0 },
  { key: "offset_x", range: "mappingOffsetX", number: "mappingOffsetXNumber", decimals: 2 },
  { key: "offset_y", range: "mappingOffsetY", number: "mappingOffsetYNumber", decimals: 2 },
  { key: "video_rotation", range: "mappingVideoRotation", number: "mappingVideoRotationNumber", decimals: 0 },
].map((c) => ({
  ...c,
  rangeEl: document.getElementById(c.range),
  numberEl: document.getElementById(c.number),
}));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function paintMappingControls(mapping) {
  MAPPING_CONTROLS.forEach(({ key, rangeEl, numberEl, decimals }) => {
    const value = Number(mapping[key]);
    rangeEl.value = value;
    numberEl.value = value.toFixed(decimals);
  });
  mappingShadingEnabled = !!mapping.shading;
  mappingShadingBtn.textContent = mappingShadingEnabled
    ? "Turn off calibration shading"
    : "Turn on calibration shading";
  previewGizmoEnabled = !!mapping.gizmo;
  previewGizmoBtn.textContent = previewGizmoEnabled ? "Hide preview gizmo" : "Show preview gizmo";
  mappingFpsEnabled = !!mapping.fps;
  mappingFpsBtn.textContent = mappingFpsEnabled ? "Hide FPS on output" : "Show FPS on output";
  mappingFlipHEnabled = !!mapping.video_flip_h;
  mappingFlipHBtn.textContent = mappingFlipHEnabled ? "Un-flip video horizontally" : "Flip video horizontally";
  for (const key of Object.keys(keystoneValues)) {
    if (mapping[key] !== undefined) keystoneValues[key] = Number(mapping[key]) || 0;
  }
  paintKeystone();
  mappingFlipVEnabled = !!mapping.video_flip_v;
  mappingFlipVBtn.textContent = mappingFlipVEnabled ? "Un-flip video vertically" : "Flip video vertically";
  broadcastMapping();
}

// ------------------------------------------------------- output preview
// The preview opens as its own tab (templates/mirror.html), which renders
// the calibration client-side through the same module this panel used to
// drive in an overlay. A separate tab rather than a floating box because
// it can then sit on a second screen next to the physical print, which is
// what calibrating against it actually wants.
//
// Named target rather than "_blank" so clicking again focuses the tab
// that's already open instead of piling up new ones.
previewToggleBtn.addEventListener("click", () => {
  window.open("/projection/mirror", "zealandataOutputMirror");
});

// The mirror tab polls /api/mapping on its own, which is what makes it
// work when opened by itself -- but a poll can only follow a slider about
// half a second behind, which is too slow to nudge alignment against the
// physical print. So this pushes the slider values straight across as they
// move: same origin, same browser, no server round-trip, and the tab
// renders in lockstep the way the old floating overlay did.
//
// One-way by design -- this page only posts and the mirror only listens,
// so there's no loop to guard against. Posting with nothing open is a
// no-op, so this costs nothing when the mirror isn't running.
const mappingChannel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("zealandata-mapping") : null;

// Only the fields the mirror actually renders from -- the sliders' own
// live values rather than what the server has stored, which is the whole
// point of pushing them.
function currentMappingSnapshot() {
  const snap = {
    shading: mappingShadingEnabled,
    gizmo: previewGizmoEnabled,
    video_flip_h: mappingFlipHEnabled,
    video_flip_v: mappingFlipVEnabled,
    // No slider of their own to read back, so they come from the store the
    // pad writes to -- without these the mirror would draw an un-keystoned
    // picture while a corner was being dragged.
    ...keystoneValues,
    // UI-only selection state, never persisted server-side -- lets the
    // mirror glow the corner that's actually selected, not just wherever
    // the last drag happened to leave off.
    keystone_corner: keystoneCorner,
  };
  MAPPING_CONTROLS.forEach(({ key, rangeEl }) => { snap[key] = Number(rangeEl.value); });
  return snap;
}

function broadcastMapping() {
  if (!mappingChannel) return;
  mappingChannel.postMessage(currentMappingSnapshot());
}

// Persisted mapping.json field (see server.py's MAPPING_BOOLEAN), not
// preview-only state -- toggling it here also takes effect on the real
// HDMI output, same as every other calibration control (shading included).
let previewGizmoEnabled = false;

previewGizmoBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, gizmo: !previewGizmoEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});

async function loadMappingState() {
  const res = await fetch("/api/mapping");
  paintMappingControls(await res.json());
}

let mappingPending = {};
let mappingSendTimer = null;
function sendMappingUpdate(partial) {
  if (!adminToken) return;
  // Straight across to the mirror on the slider's own live value, rather
  // than waiting for the debounced POST below and the mirror's next poll.
  broadcastMapping();
  // Sliders fire continuously while dragging -- debounce so each drag only
  // sends a burst of requests, not one per pixel of movement. Pending
  // fields are merged (not replaced) across calls so nudging one slider
  // right after another, both within the debounce window, doesn't drop
  // the first one's update.
  Object.assign(mappingPending, partial);
  if (mappingSendTimer) clearTimeout(mappingSendTimer);
  mappingSendTimer = setTimeout(async () => {
    const body = { token: adminToken, ...mappingPending };
    mappingPending = {};
    await fetch("/api/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, 30);
}

MAPPING_CONTROLS.forEach(({ key, rangeEl, numberEl, decimals }) => {
  rangeEl.addEventListener("input", () => {
    numberEl.value = Number(rangeEl.value).toFixed(decimals);
    sendMappingUpdate({ [key]: Number(rangeEl.value) });
  });
  numberEl.addEventListener("change", () => {
    const min = Number(rangeEl.min);
    const max = Number(rangeEl.max);
    const value = clamp(Number(numberEl.value) || 0, min, max);
    numberEl.value = value.toFixed(decimals);
    rangeEl.value = value;
    sendMappingUpdate({ [key]: value });
  });
});
// ------------------------------------------------- collapsible sections
// Which calibration sections are twirled open is remembered per browser,
// since the panel gets reopened constantly while calibrating and having
// them all snap shut on every reload would undo the point of collapsing
// them in the first place. Closed is the default: the panel is long, and
// an operator is usually working in one group at a time.
const SECTION_STATE_KEY = "zealandata.openSections";

(function restoreSectionState() {
  let open = [];
  try {
    open = JSON.parse(localStorage.getItem(SECTION_STATE_KEY) || "[]");
  } catch (e) {
    // Unreadable or disabled storage -- fall back to all closed.
  }
  document.querySelectorAll(".mapping-section").forEach((section) => {
    section.open = open.includes(section.id);
    section.addEventListener("toggle", () => {
      const ids = [...document.querySelectorAll(".mapping-section")]
        .filter((s) => s.open)
        .map((s) => s.id);
      try {
        localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(ids));
      } catch (e) {
        // Not worth surfacing -- the sections still work, they just won't
        // be remembered.
      }
    });
  });
})();

// ----------------------------------------------------- keystone corners
// The eight X/Y sliders these replaced gave no sense of which corner was
// which, or which way it would move. One corner is selected at a time and
// dragged on a pad standing for the projected picture, so the gesture
// matches what happens on the wall.
//
// Kept out of MAPPING_CONTROLS (which pairs a range input with a number
// input) since there are no sliders here -- but the values still have to
// reach both the server and the mirror tab, so they live in this object
// and are folded into currentMappingSnapshot.
const KEYSTONE_RANGE = 0.3;   // matches the number inputs' min/max
const KEYSTONE_STEP = 0.005;  // and their step, for the +/- buttons
const keystonePad = document.getElementById("keystonePad");
const keystoneHandle = document.getElementById("keystoneHandle");
// Matches whichever data-corner the template marks .is-selected by default
// (currently the "Top left" button, which -- see its own comment in
// index.html -- deliberately carries data-corner="br") rather than the
// field this variable's own name might suggest.
let keystoneCorner = "br";
const keystoneValues = {
  keystone_tl_x: 0, keystone_tl_y: 0, keystone_tr_x: 0, keystone_tr_y: 0,
  keystone_bl_x: 0, keystone_bl_y: 0, keystone_br_x: 0, keystone_br_y: 0,
};

function keystoneKey(axis) {
  return `keystone_${keystoneCorner}_${axis}`;
}

// The handle is the only readout: the pad reads like the projected
// picture, so where it sits is the value. +Y is up on the wall, and up the
// screen is a smaller CSS top, so the Y axis flips on the way out.
//
// The picture itself lands rotated a full 180 degrees for the viewer
// relative to the raw keystone_* fields -- both axes, not just top/bottom
// -- see index.html's keystone__corners comment (measured directly against
// the real output, not assumed) on why the corner *buttons* cross to their
// label's diagonal opposite. The same flip applies here: dragging the
// handle up-and-right is meant to move the corner up-and-right on the
// wall, which means DECREASING both stored field values, not increasing
// them. Pad position is kept in this "up/right is positive" sense
// throughout the pad code below, and converted to/from the fields' own
// (inverted) sign only at the places that actually touch storage -- here,
// and setKeystone. Negation is its own inverse, so one helper covers both
// directions for either axis.
const flipKeystoneField = (v) => -v;

function paintKeystone() {
  const x = flipKeystoneField(keystoneValues[keystoneKey("x")]);
  const y = flipKeystoneField(keystoneValues[keystoneKey("y")]);
  keystoneHandle.style.left = `${((x + KEYSTONE_RANGE) / (2 * KEYSTONE_RANGE)) * 100}%`;
  keystoneHandle.style.top = `${((KEYSTONE_RANGE - y) / (2 * KEYSTONE_RANGE)) * 100}%`;
}

// Real-output corner glow (see projector.c's keystone-corner-marker
// comment): persisted to mapping.json like everything else here, but
// deliberately ephemeral -- an admin tab left open on a corner shouldn't
// leave a permanent white circle sitting on the projected picture. Every
// touch of the pad (select, drag, nudge) both pushes the current corner and
// pushes the clock out; once KEYSTONE_ACTIVE_MS passes with no further
// touch, it's cleared back to "" on its own.
const KEYSTONE_ACTIVE_MS = 5000;
let keystoneActiveTimer = null;
function markKeystoneActive() {
  sendMappingUpdate({ keystone_corner: keystoneCorner });
  if (keystoneActiveTimer) clearTimeout(keystoneActiveTimer);
  keystoneActiveTimer = setTimeout(() => {
    keystoneActiveTimer = null;
    sendMappingUpdate({ keystone_corner: "" });
  }, KEYSTONE_ACTIVE_MS);
}

// x, y are pad-space (up/right positive, matching the drag gesture) --
// see flipKeystoneField's comment for why both axes get negated on their
// way into storage.
function setKeystone(x, y) {
  const nx = clamp(x, -KEYSTONE_RANGE, KEYSTONE_RANGE);
  const ny = clamp(y, -KEYSTONE_RANGE, KEYSTONE_RANGE);
  const fieldX = flipKeystoneField(nx);
  const fieldY = flipKeystoneField(ny);
  keystoneValues[keystoneKey("x")] = fieldX;
  keystoneValues[keystoneKey("y")] = fieldY;
  paintKeystone();
  sendMappingUpdate({ [keystoneKey("x")]: fieldX, [keystoneKey("y")]: fieldY });
  markKeystoneActive();
}

document.querySelectorAll(".keystone__corner").forEach((btn) => {
  btn.addEventListener("click", () => {
    keystoneCorner = btn.dataset.corner;
    document.querySelectorAll(".keystone__corner").forEach((other) => {
      const on = other === btn;
      other.classList.toggle("is-selected", on);
      other.setAttribute("aria-pressed", String(on));
    });
    paintKeystone();
    // So the mirror's corner glow jumps to the new selection right away,
    // rather than waiting on the next slider drag to happen to broadcast it.
    broadcastMapping();
    // And the real projector's corner glow too -- this is the one that
    // actually needs a server round-trip, not just the same-browser
    // BroadcastChannel the mirror tab listens on.
    markKeystoneActive();
  });
});

// Pointer events rather than mouse ones so a finger on the admin tablet
// drags the same way a mouse does.
(function enableKeystonePadDrag() {
  let dragging = false;
  const valueFromEvent = (e) => {
    const rect = keystonePad.getBoundingClientRect();
    const fx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const fy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    // Rounded to a thousandth: finer than the +/- step, but not so fine
    // that a drag spams distinct values the debounce then has to coalesce.
    const round = (v) => Math.round(v * 1000) / 1000;
    return [round(fx * 2 * KEYSTONE_RANGE - KEYSTONE_RANGE),
            round(KEYSTONE_RANGE - fy * 2 * KEYSTONE_RANGE)];
  };
  keystonePad.addEventListener("pointerdown", (e) => {
    dragging = true;
    keystonePad.setPointerCapture(e.pointerId);
    setKeystone(...valueFromEvent(e));
    e.preventDefault();
  });
  keystonePad.addEventListener("pointermove", (e) => {
    if (dragging) setKeystone(...valueFromEvent(e));
  });
  const end = () => { dragging = false; };
  keystonePad.addEventListener("pointerup", end);
  keystonePad.addEventListener("pointercancel", end);
  // Arrow keys nudge by exactly the same step the +/- buttons use, so the
  // pad is usable without a steady hand.
  keystonePad.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!d) return;
    e.preventDefault();
    // Un-flip both stored fields back to pad-space before nudging -- see
    // flipKeystoneField's comment -- so the arrow keys still point the way
    // they're drawn.
    setKeystone(flipKeystoneField(keystoneValues[keystoneKey("x")]) + d[0] * KEYSTONE_STEP,
                flipKeystoneField(keystoneValues[keystoneKey("y")]) + d[1] * KEYSTONE_STEP);
  });
})();

[["keystoneXDown", "x", -1], ["keystoneXUp", "x", 1],
 ["keystoneYDown", "y", -1], ["keystoneYUp", "y", 1]].forEach(([id, axis, dir]) => {
  document.getElementById(id).addEventListener("click", () => {
    // Un-flip both back to pad-space before nudging -- see
    // flipKeystoneField's comment -- so e.g. the Y+ ("Move corner up")
    // button still means "up" here.
    const x = flipKeystoneField(keystoneValues[keystoneKey("x")]);
    const y = flipKeystoneField(keystoneValues[keystoneKey("y")]);
    if (axis === "x") setKeystone(x + dir * KEYSTONE_STEP, y);
    else setKeystone(x, y + dir * KEYSTONE_STEP);
  });
});

document.querySelectorAll(".mapping-row__step").forEach((btn) => {
  const control = MAPPING_CONTROLS.find((c) => c.range === btn.dataset.target);
  if (!control) return;
  const { key, rangeEl, numberEl, decimals } = control;
  btn.addEventListener("click", () => {
    const step = Number(rangeEl.step) || 1;
    const dir = Number(btn.dataset.dir);
    const min = Number(rangeEl.min);
    const max = Number(rangeEl.max);
    const value = clamp(Number(rangeEl.value) + dir * step, min, max);
    rangeEl.value = value;
    numberEl.value = value.toFixed(decimals);
    sendMappingUpdate({ [key]: value });
  });
});
mappingShadingBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, shading: !mappingShadingEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});

mappingFpsBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, fps: !mappingFpsEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});

mappingFlipHBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, video_flip_h: !mappingFlipHEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});

mappingFlipVBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, video_flip_v: !mappingFlipVEnabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});
let gridcheckActive = false;
function paintGridcheckBtn(active) {
  gridcheckActive = active;
  mappingGridcheckBtn.textContent = active ? "Stop grid check" : "Play grid check (loop)";
}
mappingGridcheckBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  if (gridcheckActive) {
    await fetch("/api/control/stop", { method: "POST" });
    paintGridcheckBtn(false);
    return;
  }
  const res = await fetch("/api/mapping/gridcheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    alert(data.error);
    return;
  }
  paintGridcheckBtn(true);
});
mappingResetBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const defaults = {
    scale: 1, rotation_x: 0, rotation_y: 0, rotation_z: 0, offset_x: 0, offset_y: 0,
    video_rotation: 0, video_flip_h: false, video_flip_v: true,
    keystone_tl_x: 0, keystone_tl_y: 0, keystone_tr_x: 0, keystone_tr_y: 0,
    keystone_bl_x: 0, keystone_bl_y: 0, keystone_br_x: 0, keystone_br_y: 0,
  };
  const res = await fetch("/api/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, ...defaults }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.error) paintMappingControls(data);
});

async function renameMedia(item) {
  const newTitle = prompt("Rename video:", item.title);
  if (!newTitle || !newTitle.trim() || newTitle.trim() === item.title) return;
  const res = await fetch(`/api/media/${item.id}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken, title: newTitle.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    alert(data.error);
    return;
  }
  loadMedia();
}

// Repopulates the category dropdown from whatever's currently in the
// library, keeping the "+ New category…" option last and preserving the
// current selection if it still exists (falls back to Uncategorized).
function paintUploadCategories() {
  const prevValue = uploadCategorySelect.value;
  const categories = [...new Set(allMediaItems.map((i) => i.category).filter((c) => c && c !== "Uncategorized"))]
    .sort((a, b) => a.localeCompare(b));

  uploadCategorySelect.innerHTML = "";
  const uncatOpt = document.createElement("option");
  uncatOpt.value = "";
  uncatOpt.textContent = "Uncategorized";
  uploadCategorySelect.appendChild(uncatOpt);

  for (const cat of categories) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    uploadCategorySelect.appendChild(opt);
  }

  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New category…";
  uploadCategorySelect.appendChild(newOpt);

  if ([...uploadCategorySelect.options].some((o) => o.value === prevValue)) {
    uploadCategorySelect.value = prevValue;
  }
  uploadNewCategory.classList.toggle("hidden", uploadCategorySelect.value !== "__new__");
}

uploadCategorySelect.addEventListener("change", () => {
  uploadNewCategory.classList.toggle("hidden", uploadCategorySelect.value !== "__new__");
  if (uploadCategorySelect.value === "__new__") uploadNewCategory.focus();
});

uploadChooseBtn.addEventListener("click", () => uploadInput.click());

uploadInput.addEventListener("change", () => {
  const file = uploadInput.files[0];
  uploadBtn.classList.toggle("hidden", !file);
  uploadAttachmentsChooseBtn.classList.toggle("hidden", !file);
  uploadChooseBtn.textContent = file ? file.name : "Choose file…";
});

uploadAttachmentsChooseBtn.addEventListener("click", () => uploadAttachmentsInput.click());

uploadAttachmentsInput.addEventListener("change", () => {
  const files = [...uploadAttachmentsInput.files];
  uploadAttachmentsChooseBtn.textContent = files.length
    ? `${files.length} supplementary file${files.length === 1 ? "" : "s"} selected`
    : "Add supplementary files (optional)";
});

// ------------------------------------------------ projected thumbnails
// A library thumbnail is a frame of the video rendered through the frozen
// thumbnail view (server.py's THUMBNAIL_VIEW_FILE) -- the same view of the
// model the output mirror tab shows -- rather than a flat grab of the video
// frame. It's done here, in the page, because that view is defined by
// WebGL running in the browser; see calibration_preview.js's
// renderFrameToBlob for why it isn't reproduced server-side instead.
//
// Best-effort throughout: the upload has already succeeded before any of
// this runs, so a browser that can't decode the file (an .mkv whose codecs
// it doesn't carry, say) costs the projected thumbnail and nothing else --
// the server falls back to a plain extracted frame.
// Fixed 1080x1920 portrait, deliberately independent of the browser window
// the upload happens in. The render aspect is not just a crop -- it decides
// how the model is framed (see calibration_preview.js's buildMatrices, which
// builds the frustum from the drawing buffer's own aspect) -- so letting it
// follow whoever's window did the upload would frame every thumbnail
// differently. Portrait because that's the shape the display these are
// headed for wants.
const THUMB_WIDTH = 1080;
const THUMB_HEIGHT = 1920;

// Imported on demand rather than up front: app.js is a classic script (not
// a module), and the renderer pulls the whole projection model down with
// it, which is far too much to load for a page that may never upload
// anything.
let previewModulePromise = null;
function previewModule() {
  if (!previewModulePromise) previewModulePromise = import("/static/calibration_preview.js");
  return previewModulePromise;
}

// One reused off-screen canvas: the renderer keeps a single WebGL context
// bound to a single canvas, so handing it a fresh one per upload would leak
// a context each time.
let thumbCanvas = null;
function thumbnailCanvas() {
  if (!thumbCanvas) {
    thumbCanvas = document.createElement("canvas");
    thumbCanvas.hidden = true;
    document.body.appendChild(thumbCanvas);
  }
  return thumbCanvas;
}

// Decodes one frame out of the file the user is uploading, without waiting
// for a server round-trip -- the browser already has the file in hand.
// Aims at the same ~10% mark server.py's _extract_frame picks, so the
// projected thumbnail and the server's fallback show the same moment.
function extractVideoFrame(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      fn(arg);
    };
    // A file the browser can't decode fires neither seeked nor error in
    // some cases, so this is what stops an upload hanging on it forever.
    const timer = setTimeout(() => finish(reject, new Error("timed out decoding video")), 20000);
    const grab = () => {
      clearTimeout(timer);
      try {
        const frame = document.createElement("canvas");
        frame.width = video.videoWidth;
        frame.height = video.videoHeight;
        frame.getContext("2d").drawImage(video, 0, 0);
        finish(resolve, frame);
      } catch (err) {
        finish(reject, err);
      }
    };
    video.muted = true;
    video.preload = "auto";
    video.addEventListener("error", () => {
      clearTimeout(timer);
      finish(reject, new Error("browser cannot decode this video"));
    });
    video.addEventListener("loadeddata", () => {
      const at = Math.min(Math.max((video.duration || 0) * 0.1, 0.1), 60);
      // A stream with no seekable duration (some .webm exports) reports
      // Infinity -- take whatever frame already decoded rather than seeking
      // to a timestamp that will never resolve.
      if (!Number.isFinite(at) || at <= 0) return grab();
      video.addEventListener("seeked", grab, { once: true });
      video.currentTime = at;
    }, { once: true });
    video.src = url;
  });
}

async function fetchThumbnailView() {
  const res = await fetch("/api/thumbnail-view", { cache: "no-store" });
  const { view } = await res.json();
  return view || null;
}

// Fetched rather than pointed at with an <img src>: the endpoint is admin
// gated and the token belongs in the body, not in a URL (see server.py's
// api_media_frame).
async function fetchSourceFrame(mediaId) {
  const res = await fetch(`/api/admin/frame/${mediaId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken }),
  });
  if (!res.ok) throw new Error(`no frame available (${res.status})`);
  return await createImageBitmap(await res.blob());
}

async function renderAndStoreThumbnail(view, source, mediaId) {
  const preview = await previewModule();
  const blob = await preview.renderFrameToBlob({
    canvasEl: thumbnailCanvas(),
    mapping: view,
    source,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
  });
  const form = new FormData();
  form.append("token", adminToken);
  form.append("image", blob, `${mediaId}.jpg`);
  const res = await fetch(`/api/admin/thumbnail/${mediaId}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`storing the thumbnail failed (${res.status})`);
}

async function captureProjectedThumbnail(file, item) {
  if (!item || !item.id) return;
  try {
    // No view captured yet -- leave the item to the server rather than
    // inventing one from the live calibration, which is exactly the
    // "depends on the sliders right now" behaviour the frozen view avoids.
    const view = await fetchThumbnailView();
    if (!view) return;
    uploadStatus.textContent = "Rendering thumbnail…";
    await renderAndStoreThumbnail(view, await extractVideoFrame(file), item.id);
  } catch (err) {
    console.warn("[thumbnail] projected render failed; falling back to the server's own", err);
  }
}

// ------------------------------------------- thumbnail view + backfill
async function refreshThumbnailViewNote() {
  if (!thumbnailViewNote) return;
  const view = await fetchThumbnailView().catch(() => null);
  thumbnailViewNote.textContent = view
    ? "A view is captured — uploads render through it, not through the live calibration."
    : "No view captured yet — thumbnails stay plain video frames until one is.";
}

// Renders the whole library through the captured view, one item at a time.
// Driven from here rather than the server for the same reason the upload
// path is (see captureProjectedThumbnail): this is where the renderer that
// defines the view actually runs. It's also the only way a video copied
// straight into the media folder ever gets a projected thumbnail, since
// nothing rendered one for it at upload time.
//
// Sequential on purpose -- every render goes through the one WebGL context,
// and a 1080x1920 draw per item is enough work that firing them all at once
// would just queue up inside the GPU anyway.
thumbnailRerenderBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  const view = await fetchThumbnailView().catch(() => null);
  if (!view) {
    thumbnailRerenderStatus.textContent = "Capture a view first.";
    return;
  }

  thumbnailRerenderBtn.disabled = true;
  thumbnailRerenderStatus.textContent = "Loading library…";
  let done = 0;
  let failed = 0;
  try {
    const items = await (await fetch("/api/media")).json();
    for (const item of items) {
      thumbnailRerenderStatus.textContent = `Rendering ${done + failed + 1} of ${items.length}…`;
      try {
        await renderAndStoreThumbnail(view, await fetchSourceFrame(item.id), item.id);
        done++;
      } catch (err) {
        // One unreadable video shouldn't stop the rest of the library.
        console.warn(`[thumbnail] ${item.id} failed`, err);
        failed++;
      }
    }
    thumbnailRerenderStatus.textContent =
      `Rendered ${done} thumbnail${done === 1 ? "" : "s"}` +
      (failed ? `, ${failed} could not be rendered.` : ".");
    await loadMedia();
  } catch (err) {
    thumbnailRerenderStatus.textContent = "Re-render failed — check your connection.";
  } finally {
    thumbnailRerenderBtn.disabled = false;
  }
});

uploadBtn.addEventListener("click", async () => {
  const file = uploadInput.files[0];
  if (!file) return;

  const category = uploadCategorySelect.value === "__new__"
    ? uploadNewCategory.value.trim()
    : uploadCategorySelect.value;

  const form = new FormData();
  form.append("token", adminToken);
  form.append("category", category);
  form.append("file", file);
  for (const att of uploadAttachmentsInput.files) form.append("attachments", att);

  uploadBtn.disabled = true;
  uploadChooseBtn.disabled = true;
  uploadAttachmentsChooseBtn.disabled = true;
  uploadStatus.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch("/api/admin/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      uploadStatus.textContent = data.error || "Upload failed";
      return;
    }
    // Before the file inputs are cleared below -- this still needs the File
    // itself to decode a frame out of.
    await captureProjectedThumbnail(file, data.item);

    uploadStatus.textContent = `Uploaded ${file.name}`;
    uploadInput.value = "";
    uploadAttachmentsInput.value = "";
    uploadNewCategory.value = "";
    uploadBtn.classList.add("hidden");
    uploadAttachmentsChooseBtn.classList.add("hidden");
    uploadChooseBtn.textContent = "Choose file…";
    uploadAttachmentsChooseBtn.textContent = "Add supplementary files (optional)";
    await loadMedia();
  } catch (err) {
    uploadStatus.textContent = "Upload failed — check your connection";
  } finally {
    uploadBtn.disabled = false;
    uploadChooseBtn.disabled = false;
    uploadAttachmentsChooseBtn.disabled = false;
  }
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

function getMediaById(id) {
  return allMediaItems.find((i) => i.id === id) || null;
}

// Lightbox for the current video's attachments -- opens on whichever chip
// was clicked, and lets you flick left/right through the rest of that
// video's docs/images without closing and reopening.
let docViewerList = [];
let docViewerIndex = 0;

function renderDocViewerItem() {
  const att = docViewerList[docViewerIndex];
  docViewerContent.innerHTML = "";
  if (att.kind === "image") {
    const img = document.createElement("img");
    img.src = att.url;
    img.alt = att.name;
    docViewerContent.appendChild(img);
  } else {
    const frame = document.createElement("iframe");
    frame.src = att.url;
    frame.title = att.name;
    docViewerContent.appendChild(frame);
  }
  const multiple = docViewerList.length > 1;
  docViewerPrev.classList.toggle("hidden", !multiple);
  docViewerNext.classList.toggle("hidden", !multiple);
  docViewerCounter.classList.toggle("hidden", !multiple);
  if (multiple) docViewerCounter.textContent = `${docViewerIndex + 1} / ${docViewerList.length}`;
}

function openDocViewer(list, index) {
  docViewerList = list;
  docViewerIndex = index;
  renderDocViewerItem();
  openOverlay(docScrim, docViewer);
}
function closeDocViewer() {
  closeOverlay(docScrim, docViewer, () => {
    docViewerContent.innerHTML = "";
    docViewerList = [];
  });
}
function stepDocViewer(delta) {
  docViewerIndex = (docViewerIndex + delta + docViewerList.length) % docViewerList.length;
  renderDocViewerItem();
}
docViewerClose.addEventListener("click", closeDocViewer);
docScrim.addEventListener("click", closeDocViewer);
docViewerPrev.addEventListener("click", () => stepDocViewer(-1));
docViewerNext.addEventListener("click", () => stepDocViewer(1));
window.addEventListener("keydown", (e) => {
  if (!docViewer.classList.contains("is-open")) return;
  if (e.key === "Escape") closeDocViewer();
  else if (e.key === "ArrowLeft") stepDocViewer(-1);
  else if (e.key === "ArrowRight") stepDocViewer(1);
});

// Floats above the dock as its own scrollable strip (with hover arrows once
// there are enough chips to overflow), rather than being crammed inside it.
const dockDocsScrollUpdate = wrapScroller(dockDocs);
const dockDocsViewport = dockDocs.parentElement;
dockDocsViewport.classList.add("dock-docs-viewport");
const dockDocsPanel = document.getElementById("dockDocsPanel");
dockDocsPanel.classList.add("hidden");

// Only fades the edge that actually has more chips scrolled past it --
// chips fully within the dock's own width stay fully opaque, matching its
// edges exactly rather than fading decoratively regardless of overflow.
function updateDocsFade() {
  const max = dockDocs.scrollWidth - dockDocs.clientWidth;
  const canLeft = dockDocs.scrollLeft > 4;
  const canRight = max > 4 && dockDocs.scrollLeft < max - 4;
  const mask = `linear-gradient(to right, ${canLeft ? "transparent" : "black"} 0, black 64px, black calc(100% - 64px), ${canRight ? "transparent" : "black"} 100%)`;
  dockDocs.style.webkitMaskImage = mask;
  dockDocs.style.maskImage = mask;
}
dockDocs.addEventListener("scroll", updateDocsFade);
window.addEventListener("resize", updateDocsFade);

// Supplementary docs/images for the currently playing video (a paper PDF,
// reference images, ...), shown as chips that open in the lightbox above,
// flickable left/right through the rest of that video's attachments.
function paintDocs(attachments) {
  dockDocs.innerHTML = "";
  const list = attachments || [];
  dockDocsPanel.classList.toggle("hidden", list.length === 0);
  list.forEach((att, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dock__doc-chip";
    chip.title = att.name;
    const thumb = document.createElement("img");
    thumb.className = "dock__doc-chip__thumb" + (att.kind === "image" ? "" : " dock__doc-chip__thumb--icon");
    thumb.src = att.kind === "image" ? att.url : "/static/icons/pdf.svg";
    thumb.alt = "";
    chip.appendChild(thumb);
    chip.addEventListener("click", () => openDocViewer(list, index));
    dockDocs.appendChild(chip);
  });
  dockDocsScrollUpdate();
  updateDocsFade();
}

let currentPlayingId = null;

// Buttons that only make sense once something's actually playing -- kept
// visible at all times (the dock itself is never hidden) but disabled
// while idle, rather than acting on whatever the screensaver happens to
// be showing.
const dockPlaybackBtns = [seekBackBtn, seekFwdBtn, pauseBtn, loopBtn, playerStopBtn, setHeroBtn];

function paintDockIdle(screensaverTitle) {
  currentPlayingId = null;
  playerTitle.textContent = screensaverTitle ? `Screensaver mode: ${screensaverTitle}` : "Nothing playing";
  paintPreview(null);
  paintDocs(null);
  playerScrubControls.classList.add("hidden");
  frameCounter.classList.add("hidden");
  currentFrameCount = null;
  setPauseIcon(false);
  paintLoopBtn(false);
  paintSetHeroBtn();
  dockPlaybackBtns.forEach((btn) => { btn.disabled = true; });
}

async function playItem(item, { resume = false, restart = false } = {}) {
  unselectCardOnly(); // in case this came from the hero's own Play button
  currentPlayingId = item.id;
  playerTitle.textContent = item.title;
  paintPreview(item.thumbnail);
  paintDocs(item.attachments);
  setSequenceMode(!!item.is_sequence, item.frame_count, 0);
  setPauseIcon(false);
  paintSetHeroBtn();
  dockPlaybackBtns.forEach((btn) => { btn.disabled = false; });

  await fetch(`/api/play/${item.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume, restart }),
  });
}

async function stopPlayback() {
  await control("stop");
  paintDockIdle();
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
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
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
  scrubBar.setPointerCapture(e.pointerId);
  const frac = fracFromEvent(e);
  paintScrub(frac);
  playerPos.textContent = fmtTime(knownDuration * frac);
  e.preventDefault();
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
// Pointer events (matching the keystone pad's pattern) rather than
// separate mouse/touch listeners -- those double-fired on touch devices,
// since touchend is followed by a synthetic mousedown/mouseup pair that
// could restart a scrub after it had already ended.
scrubBar.addEventListener("pointerdown", startScrub);
scrubBar.addEventListener("pointermove", moveScrub);
scrubBar.addEventListener("pointerup", endScrub);
scrubBar.addEventListener("pointercancel", () => { scrubbing = false; });

// ----------------------------------------------------------------------
// Status polling — keeps the player in sync (including a fresh pageload
// or a second browser tab catching mid-playback), and detects natural end.

let wasPlaying = false;

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    paintGridcheckBtn(!!(s.playing && s.is_gridcheck));
    if (s.playing) {
      if (!wasPlaying) {
        // something's playing that this client didn't initiate (fresh
        // pageload, or another tab pressed play) — enable the controls to
        // match, rather than leaving them dimmed from the idle state
        dockPlaybackBtns.forEach((btn) => { btn.disabled = false; });
      }
      wasPlaying = true;
      if (s.id && s.id !== currentPlayingId) {
        currentPlayingId = s.id;
        paintSetHeroBtn();
        paintDocs((getMediaById(s.id) || {}).attachments);
      }
      playerTitle.textContent = s.title || playerTitle.textContent;
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
        loadMedia();
      }
      // Repainted every tick, not just on the playing->idle edge, since the
      // screensaver's title itself keeps changing as it picks new videos.
      paintDockIdle(s.screensaver ? s.screensaver_title : null);
    }
  } catch (e) {
    // Pi may be mid-restart of mpv; ignore transient errors
  }
}

(async () => {
  paintDockIdle();
  await loadHeroPreference();
  await loadMedia();
  loadScreensaverState();
  loadPlayTrackingState();
  loadPopularVisibilityState();
  loadMappingState();
  refreshThumbnailViewNote();
  restoreAdminSession();
  pollStatus();
  setInterval(pollStatus, 1000);
})();
