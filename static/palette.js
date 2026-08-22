// Live colour-palette editor: lets you try different hex values against the
// real running UI (not a mockup) by writing CSS custom properties straight
// onto <html style="">, which wins over the :root rule in style.css. Nothing
// here is persisted -- reload to discard, or use "Copy CSS" to save a combo
// you like back into style.css by hand.

// Grouped by where colour actually shows up on screen (18 element groups),
// rather than by the underlying token scale -- several groups share the same
// CSS variable (e.g. --color-accent drives focus rings AND the hero scrim
// AND the dock progress bar), so editing it in any one group updates every
// other row bound to that same variable too (see PALETTE_INPUT_REGISTRY).
const PALETTE_GROUPS = [
  { title: "Page background & text", vars: [
    { name: "--color-bg", label: "Background", usage: "Page background; browse-area background" },
    { name: "--color-text", label: "Text", usage: "Default text colour; also the fill behind Play/primary buttons" },
  ]},
  { title: "Buttons", vars: [
    { name: "--color-text", label: "Primary fill", usage: "btn-primary background" },
    { name: "--color-neutral-200", label: "Hover fill", usage: "Primary/large-icon button hover background" },
    { note: "Secondary/icon button border is Text at 16% opacity (--color-divider) — adjust it via Text, above." },
    { name: "--color-accent", label: "Hover border", usage: "Icon-button hover border; focus ring on all buttons" },
  ]},
  { title: "Tags", vars: [
    { name: "--color-accent", label: "Outline", usage: "tag-outline border + text" },
    { name: "--color-accent-800", label: "Filled background", usage: "tag-accent background" },
    { name: "--color-accent-100", label: "Filled text", usage: "tag-accent text colour" },
  ]},
  { title: "Topbar", vars: [
    { name: "--color-bg", label: "Blur tint", usage: "Topbar's blurred backdrop fade (same variable as Page background)" },
  ]},
  { title: "Hero", vars: [
    { name: "--color-accent", label: "Scrim tint", usage: "Sky wash over the hero media" },
    { name: "--color-neutral-200", label: "Description text", usage: "Hero description paragraph" },
  ]},
  { title: "Category strip", vars: [
    { name: "--color-accent", label: "Backdrop tint", usage: "Sky wash over the blurred strip behind the category buttons" },
    { name: "--color-bg", label: "Backdrop fade", usage: "Navy fade behind the category buttons (same variable as Page background)" },
    { note: "Each category button's own artwork (static/buttons/*.svg) bakes in its own colour and isn't adjustable here." },
  ]},
  { title: "Row headings", vars: [
    { name: "--color-neutral-300", label: "Heading text", usage: "\"CONTINUE WATCHING\" / category row headings" },
  ]},
  { title: "Row arrows", vars: [
    { name: "--color-bg", label: "Background tint", usage: "Scroll-arrow button background (same variable as Page background)" },
    { note: "Border is Text at 16% opacity (--color-divider) — adjust it via Text, above." },
    { name: "--color-accent-800", label: "Hover fill", usage: "Scroll-arrow hover background" },
  ]},
  { title: "Cards", vars: [
    { name: "--color-neutral-800", label: "Fallback background", usage: "Card background before its thumbnail loads" },
    { name: "--color-surface", label: "Thumbnail fallback", usage: "card__thumb background before the image loads" },
    { name: "--color-accent", label: "Hover / selected glow", usage: "Ring + glow shown on hover and when selected" },
    { name: "--color-neutral-600", label: "Placeholder icon", usage: "Placeholder glyph; \"coming soon\" label text" },
    { name: "--color-text", label: "Title text", usage: "Card title" },
    { name: "--color-accent-800", label: "Rename/restart hover", usage: "Admin-mode rename/restart button hover fill" },
  ]},
  { title: "Empty state", vars: [
    { name: "--color-neutral-400", label: "Empty-state text", usage: "\"No films on the reel\" message" },
  ]},
  { title: "Drawers (Settings & Palette)", vars: [
    { name: "--color-accent-800", label: "Glass tint", usage: "Translucent panel tint (drives --color-panel-rgb)" },
  ]},
  { title: "Form fields", vars: [
    { name: "--color-neutral-900", label: "Field background", usage: "Text input / select background" },
    { note: "Border is Text at 16% opacity (--color-divider) — adjust it via Text, above." },
    { name: "--color-accent", label: "Focus border", usage: "Field border on focus" },
  ]},
  { title: "Calibration sliders", vars: [
    { name: "--color-neutral-700", label: "Track", usage: "Slider track background" },
    { name: "--color-accent", label: "Thumb / fill", usage: "Slider thumb and stepper hover colour" },
  ]},
  { title: "PIN pad", vars: [
    { name: "--color-accent", label: "Dots / keys", usage: "Filled PIN dots; keypad hover/active state" },
    { name: "--color-danger", label: "Error text", usage: "Incorrect-PIN message" },
  ]},
  { title: "Playback dock", vars: [
    { name: "--color-accent", label: "Progress bar", usage: "Scrub-bar fill and drag handle" },
    { name: "--color-neutral-300", label: "Time / frame text", usage: "Elapsed-time and frame-counter labels" },
  ]},
  { title: "Docs panel", vars: [
    { name: "--color-surface", label: "Chip background", usage: "Document chip thumbnail fallback" },
    { name: "--color-accent", label: "Chip hover border", usage: "Document chip hover state" },
  ]},
  { title: "Doc viewer", vars: [
    { name: "--color-text", label: "Iframe background", usage: "Background behind a PDF/iframe document" },
    { name: "--color-accent", label: "Nav hover", usage: "Prev/next button hover border" },
    { name: "--color-neutral-300", label: "Page counter text", usage: "\"n / total\" counter chip" },
  ]},
  { title: "Calibration preview", vars: [
    { name: "--color-axis-x", label: "X axis label", usage: "Projection-mapping preview lightbox" },
    { name: "--color-axis-y", label: "Y axis label", usage: "Projection-mapping preview lightbox" },
    { name: "--color-axis-z", label: "Z axis label", usage: "Projection-mapping preview lightbox" },
    { name: "--color-neutral-300", label: "Status text", usage: "\"Loading…\" / status overlay" },
  ]},
];

// A few colours also drive an "rgba(var(--x-rgb),A)" sibling used for the
// UI's translucent glass panels (see style.css). Those siblings won't
// update on their own -- CSS custom properties don't derive from each
// other -- so every hex edit here recomputes the matching sibling too,
// otherwise panel tints would silently fall out of sync with the swatch.
const RGB_SIBLINGS = {
  "--color-bg": "--color-bg-rgb",
  "--color-text": "--color-text-rgb",
  "--color-accent": "--color-accent-rgb",
  "--color-accent-800": "--color-panel-rgb",
};

function hexToRgbTriplet(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = parseInt(full, 16);
  return `${(int >> 16) & 255},${(int >> 8) & 255},${int & 255}`;
}

function currentValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Several groups above point at the *same* variable (e.g. --color-accent
// shows up under Buttons, Hero, Cards, PIN pad...). This registry tracks
// every swatch+hex pair rendered for a given variable so that editing it in
// any one group immediately updates its value everywhere else it's shown,
// instead of the other rows silently going stale until the panel rebuilds.
const PALETTE_INPUT_REGISTRY = {};

function uniqueVarNames() {
  const seen = new Set();
  PALETTE_GROUPS.forEach((group) => {
    group.vars.forEach(({ name }) => { if (name) seen.add(name); });
  });
  return [...seen];
}

function applyVar(name, hex) {
  document.documentElement.style.setProperty(name, hex);
  const sibling = RGB_SIBLINGS[name];
  if (sibling) document.documentElement.style.setProperty(sibling, hexToRgbTriplet(hex));

  (PALETTE_INPUT_REGISTRY[name] || []).forEach(({ swatch, hexInput }) => {
    swatch.value = hex;
    hexInput.value = hex;
  });
}

function resetPalette() {
  uniqueVarNames().forEach((name) => {
    document.documentElement.style.removeProperty(name);
    const sibling = RGB_SIBLINGS[name];
    if (sibling) document.documentElement.style.removeProperty(sibling);
  });
  document.getElementById("paletteOutput").classList.add("hidden");
  buildPaletteRows();
}

function copyPaletteCss() {
  const lines = [];
  uniqueVarNames().sort().forEach((name) => {
    lines.push(`  ${name}: ${currentValue(name)};`);
    const sibling = RGB_SIBLINGS[name];
    if (sibling) lines.push(`  ${sibling}: ${currentValue(sibling)};`);
  });
  const css = `:root{\n${lines.join("\n")}\n}`;

  const output = document.getElementById("paletteOutput");
  output.value = css;
  output.classList.remove("hidden");
  output.focus();
  output.select();

  const copyBtn = document.getElementById("paletteCopyBtn");
  const showCopied = () => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy CSS"; }, 1500);
  };
  // Clipboard API needs a secure context (https, or localhost) -- this kiosk
  // is plain http on the LAN, so it may not exist at all. The textarea above
  // is the reliable fallback (already focused+selected) either way.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(css).then(showCopied).catch(() => {});
  }
}

function buildPaletteRows() {
  Object.keys(PALETTE_INPUT_REGISTRY).forEach((k) => delete PALETTE_INPUT_REGISTRY[k]);

  const container = document.getElementById("paletteGroups");
  container.innerHTML = "";
  PALETTE_GROUPS.forEach((group) => {
    const groupEl = document.createElement("div");
    groupEl.className = "palette-group";

    const titleEl = document.createElement("div");
    titleEl.className = "palette-group__title";
    titleEl.textContent = group.title;
    groupEl.appendChild(titleEl);

    const rowsEl = document.createElement("div");
    rowsEl.className = "palette-group__rows";

    group.vars.forEach(({ name, label, usage, note }) => {
      if (!name) {
        const noteRow = document.createElement("div");
        noteRow.className = "palette-row palette-row--note";
        noteRow.textContent = note;
        rowsEl.appendChild(noteRow);
        return;
      }

      const value = currentValue(name) || "#000000";

      const row = document.createElement("div");
      row.className = "palette-row";
      row.innerHTML = `
        <div class="palette-row__meta">
          <span class="palette-row__label">${label}</span>
          <span class="palette-row__var">${name}</span>
          ${usage ? `<span class="palette-row__usage">${usage}</span>` : ""}
        </div>
        <input type="color" class="palette-swatch" value="${value}">
        <input type="text" class="palette-hex" value="${value}" maxlength="7" spellcheck="false">
      `;

      const swatch = row.querySelector(".palette-swatch");
      const hexInput = row.querySelector(".palette-hex");
      (PALETTE_INPUT_REGISTRY[name] = PALETTE_INPUT_REGISTRY[name] || []).push({ swatch, hexInput });

      swatch.addEventListener("input", () => applyVar(name, swatch.value));
      hexInput.addEventListener("input", () => {
        const v = hexInput.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) applyVar(name, v);
      });

      rowsEl.appendChild(row);
    });

    groupEl.appendChild(rowsEl);
    container.appendChild(groupEl);
  });
}

function openPalette() {
  buildPaletteRows();
  document.getElementById("paletteScrim").classList.remove("hidden");
  document.getElementById("paletteDrawer").classList.remove("hidden");
}

function closePalette() {
  document.getElementById("paletteScrim").classList.add("hidden");
  document.getElementById("paletteDrawer").classList.add("hidden");
}

document.getElementById("paletteLogoSelect").addEventListener("change", (e) => {
  document.getElementById("topbarLogo").src = e.target.value;
});

document.getElementById("paletteBtn").addEventListener("click", openPalette);
document.getElementById("paletteCloseBtn").addEventListener("click", closePalette);
document.getElementById("paletteScrim").addEventListener("click", closePalette);
document.getElementById("paletteResetBtn").addEventListener("click", resetPalette);
document.getElementById("paletteCopyBtn").addEventListener("click", copyPaletteCss);

// Deep-link convenience: ?debugPalette=1 opens the panel on load.
if (new URLSearchParams(location.search).has("debugPalette")) openPalette();
