// Live colour-palette editor: lets you try different hex values against the
// real running UI (not a mockup) by writing CSS custom properties straight
// onto <html style="">, which wins over the :root rule in style.css. Nothing
// here is persisted -- reload to discard, or use "Copy CSS" to save a combo
// you like back into style.css by hand.

const PALETTE_GROUPS = [
  { title: "Core", vars: [
    { name: "--color-bg", label: "Background", usage: "Page background; browse-area background" },
    { name: "--color-surface", label: "Surface", usage: "Hero/thumbnail fallback bg; topbar & dock bar background" },
    { name: "--color-text", label: "Text", usage: "Primary text colour; also the fill behind Play/primary buttons" },
    { name: "--color-accent", label: "Accent", usage: "Focus rings, hover borders, tags, progress fill, card hover glow" },
  ]},
  { title: "Accent tints", vars: [
    { name: "--color-accent-100", label: "Accent 100", usage: "Text colour on the filled accent tag (tag-accent)" },
    { name: "--color-accent-300", label: "Accent 300", usage: "Brand reference tint — not yet wired to an element" },
    { name: "--color-accent-400", label: "Accent 400", usage: "Brand reference tint — currently same value as Accent" },
    { name: "--color-accent-800", label: "Accent 800", usage: "Filled tag bg, row-arrow/card hover fill, active pinpad key" },
    { name: "--color-accent-900", label: "Accent 900", usage: "Brand reference tint — not yet wired to an element" },
  ]},
  { title: "Neutrals", vars: [
    { name: "--color-neutral-100", label: "Neutral 100", usage: "Brand reference tint — not yet wired to an element" },
    { name: "--color-neutral-200", label: "Neutral 200", usage: "Hero description text; hover bg for primary/icon buttons" },
    { name: "--color-neutral-300", label: "Neutral 300", usage: "Field labels, dock time/frame counters, doc-viewer captions" },
    { name: "--color-neutral-400", label: "Neutral 400", usage: "Hint text, empty-state text, ghost pinpad key" },
    { name: "--color-neutral-600", label: "Neutral 600", usage: "Placeholder-thumb icon colour; button focus-ring shadow" },
    { name: "--color-neutral-700", label: "Neutral 700", usage: "Mapping-slider track; button hover-ring shadow" },
    { name: "--color-neutral-800", label: "Neutral 800", usage: "Card fallback background; button default-ring shadow" },
    { name: "--color-neutral-900", label: "Neutral 900", usage: "Form input / select / palette-hex field backgrounds" },
  ]},
  { title: "Status", vars: [
    { name: "--color-danger", label: "Danger", usage: "Pin-pad error text; dock stop-button hover state" },
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

function applyVar(name, hex) {
  document.documentElement.style.setProperty(name, hex);
  const sibling = RGB_SIBLINGS[name];
  if (sibling) document.documentElement.style.setProperty(sibling, hexToRgbTriplet(hex));
}

function resetPalette() {
  PALETTE_GROUPS.forEach((group) => {
    group.vars.forEach(({ name }) => {
      document.documentElement.style.removeProperty(name);
      const sibling = RGB_SIBLINGS[name];
      if (sibling) document.documentElement.style.removeProperty(sibling);
    });
  });
  document.getElementById("paletteOutput").classList.add("hidden");
  buildPaletteRows();
}

function copyPaletteCss() {
  const lines = [];
  PALETTE_GROUPS.forEach((group) => {
    lines.push(`  /* ${group.title} */`);
    group.vars.forEach(({ name }) => {
      lines.push(`  ${name}: ${currentValue(name)};`);
      const sibling = RGB_SIBLINGS[name];
      if (sibling) lines.push(`  ${sibling}: ${currentValue(sibling)};`);
    });
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

    group.vars.forEach(({ name, label, usage }) => {
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
      swatch.addEventListener("input", () => {
        hexInput.value = swatch.value;
        applyVar(name, swatch.value);
      });
      hexInput.addEventListener("input", () => {
        const v = hexInput.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
          swatch.value = v;
          applyVar(name, v);
        }
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
