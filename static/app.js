// ---------------------------------------------------------------- DOM refs
const topbarScreensaverTag = document.getElementById("screensaverTag");
const startScreensaverBtn = document.getElementById("startScreensaverBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsScrim = document.getElementById("settingsScrim");
const settingsDrawer = document.getElementById("settingsDrawer");
const rescanBtn = document.getElementById("rescanBtn");
const adminModeBtn = document.getElementById("adminModeBtn");
const uploadField = document.getElementById("uploadField");
const uploadCategorySelect = document.getElementById("uploadCategorySelect");
const uploadNewCategory = document.getElementById("uploadNewCategory");
const uploadInput = document.getElementById("uploadInput");
const uploadChooseBtn = document.getElementById("uploadChooseBtn");
const uploadAttachmentsInput = document.getElementById("uploadAttachmentsInput");
const uploadAttachmentsChooseBtn = document.getElementById("uploadAttachmentsChooseBtn");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
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
const categoryRows = document.getElementById("categoryRows");

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

function buildCard(item, { badge, showRestart } = {}) {
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
      playItem(item); // clears the armed selection itself
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

let screensaverEnabled = false;

function paintScreensaverToggle(enabled) {
  screensaverEnabled = enabled;
  topbarScreensaverTag.textContent = enabled ? "Screensaver on" : "Screensaver off";
  topbarScreensaverTag.classList.toggle("tag-accent", enabled);
  topbarScreensaverTag.classList.toggle("tag-outline", !enabled);
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
topbarScreensaverTag.addEventListener("click", () => setScreensaver(!screensaverEnabled));

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
    pinScrim.classList.remove("hidden");
    pinModal.classList.remove("hidden");
  });
}

function closePinPad(result) {
  pinScrim.classList.add("hidden");
  pinModal.classList.add("hidden");
  const resolve = pinResolve;
  pinResolve = null;
  pinVerify = null;
  if (resolve) resolve(result);
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
let adminPin = null;

function paintAdminMode() {
  document.body.classList.toggle("admin-mode", !!adminPin);
  adminModeBtn.textContent = adminPin ? "Lock admin mode" : "Unlock admin mode";
  uploadField.classList.toggle("hidden", !adminPin);
  if (adminPin) paintUploadCategories();
  paintSetHeroBtn();
}

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
  return { ok: !!data.ok };
}

adminModeBtn.addEventListener("click", async () => {
  if (adminPin) {
    adminPin = null;
    paintAdminMode();
    return;
  }
  const pin = await openPinPad("Enter Admin PIN", verifyAdminPin);
  if (pin) {
    adminPin = pin;
    paintAdminMode();
  }
});

async function renameMedia(item) {
  const newTitle = prompt("Rename video:", item.title);
  if (!newTitle || !newTitle.trim() || newTitle.trim() === item.title) return;
  const res = await fetch(`/api/media/${item.id}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: adminPin, title: newTitle.trim() }),
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

uploadBtn.addEventListener("click", async () => {
  const file = uploadInput.files[0];
  if (!file) return;

  const category = uploadCategorySelect.value === "__new__"
    ? uploadNewCategory.value.trim()
    : uploadCategorySelect.value;

  const form = new FormData();
  form.append("pin", adminPin);
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
  docScrim.classList.remove("hidden");
  docViewer.classList.remove("hidden");
}
function closeDocViewer() {
  docScrim.classList.add("hidden");
  docViewer.classList.add("hidden");
  docViewerContent.innerHTML = "";
  docViewerList = [];
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
  if (docViewer.classList.contains("hidden")) return;
  if (e.key === "Escape") closeDocViewer();
  else if (e.key === "ArrowLeft") stepDocViewer(-1);
  else if (e.key === "ArrowRight") stepDocViewer(1);
});

// Floats above the dock as its own scrollable strip (with hover arrows once
// there are enough chips to overflow), rather than being crammed inside it.
const dockDocsScrollUpdate = wrapScroller(dockDocs);
const dockDocsViewport = dockDocs.parentElement;
dockDocsViewport.classList.add("dock-docs-viewport", "hidden");

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
  dockDocsViewport.classList.toggle("hidden", list.length === 0);
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

async function playItem(item, { restart = false } = {}) {
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
    body: JSON.stringify({ restart }),
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
  pollStatus();
  setInterval(pollStatus, 1000);
})();
