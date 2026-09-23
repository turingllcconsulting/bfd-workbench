// --- Color presets (v0.16.0) ---
// A preset is three hex colors. Primary / Secondary / Tertiary map onto BFD's
// three background layers; every foreground, border, hover and accent is
// derived from them, so a palette stays legible whether it is dark or light.
// The rule the derivation turns on: white text on a dark surface, black text
// on a light one, decided per surface by WCAG contrast — not once per window.

export interface ThemePreset {
  name: string;
  primary: string;
  secondary: string;
  tertiary: string;
}

// The stock catppuccin-ish palette BFD shipped with, as a preset.
export const DEFAULT_PRESET: ThemePreset = {
  name: "BFD Dark",
  primary: "#1e1e2e",
  secondary: "#181825",
  tertiary: "#11111b",
};

const PRESETS_KEY = "bfd-theme-presets";
const ACTIVE_KEY = "bfd-theme-active";

// The blue used when a palette is too desaturated to supply its own accent.
const FALLBACK_ACCENT = "#89b4fa";

// --- hex parsing ---

/** "abc" | "#AABBCC" -> "#aabbcc"; null if it isn't a hex color. */
export function normalizeHex(input: string): string | null {
  let h = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toLowerCase();
}

function toRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return "#" + part(r) + part(g) + part(b);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// --- contrast ---

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** White on a dark background, black on a light one — whichever reads better. */
export function fgFor(bg: string): string {
  return contrast("#ffffff", bg) >= contrast("#000000", bg) ? "#ffffff" : "#000000";
}

/** True when the surface wants black text (i.e. it is a light color). */
export function isLightColor(hex: string): boolean {
  return fgFor(hex) === "#000000";
}

/** True when the window as a whole reads as a light theme. */
export function isLightTheme(p: ThemePreset): boolean {
  return isLightColor(p.primary);
}

/** Blend `a` into `b`; weightA 1 = pure a, 0 = pure b. */
function mix(a: string, b: string, weightA: number): string {
  const [r1, g1, b1] = toRgb(a);
  const [r2, g2, b2] = toRgb(b);
  const t = clamp01(weightA);
  return toHex(r1 * t + r2 * (1 - t), g1 * t + g2 * (1 - t), b1 * t + b2 * (1 - t));
}

// --- HSL, for nudging accents into contrast without losing their hue ---

function toHsl(hex: string): { h: number; s: number; l: number } {
  const [r0, g0, b0] = toRgb(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return toHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

/** How much color a swatch actually carries — saturation weighted by how far
 *  it is from black or white, so a near-black navy doesn't count as "blue". */
function chroma(hex: string): number {
  const { s, l } = toHsl(hex);
  return s * (1 - Math.abs(2 * l - 1));
}

/** Walk lightness in one direction until the color reads against `bg`. */
function walk(h: number, sat: number, from: number, step: number, bg: string, target: number): string | null {
  let l = from;
  for (let i = 0; i < 34; i++) {
    l = clamp01(l + step);
    const next = fromHsl(h, sat, l);
    if (contrast(next, bg) >= target) return next;
    if (l === 0 || l === 1) return null;
  }
  return null;
}

/**
 * Keep a color's hue but move its lightness until it reads against `bg`.
 * Used for the accent and the semantic green/red/yellow, so "error red" stays
 * red on a white theme instead of washing out. Tries the natural direction
 * first (darken on a light background, lighten on a dark one) and falls back
 * to the other, which is what saves mid-tone backgrounds from a black-or-white
 * accent with no hue left in it.
 */
function adapt(color: string, bg: string, target = 4.5): string {
  if (contrast(color, bg) >= target) return color;
  const { h, s, l } = toHsl(color);
  const sat = Math.max(s, 0.45);
  const first = isLightColor(bg) ? -0.03 : 0.03;
  return walk(h, sat, l, first, bg, target) ?? walk(h, sat, l, -first, bg, target) ?? fgFor(bg);
}

/**
 * The accent is the most colorful of the three chosen colors, pushed into
 * contrast against the main background. A palette of near-neutrals has no
 * accent to give, so it falls back to BFD's blue — which is why applying the
 * stock "BFD Dark" preset reproduces today's window exactly.
 */
function pickAccent(p: ThemePreset): string {
  const candidates = [p.tertiary, p.secondary, p.primary];
  let best = candidates[0];
  let bestChroma = chroma(candidates[0]);
  for (const c of candidates.slice(1)) {
    const ch = chroma(c);
    if (ch > bestChroma) {
      best = c;
      bestChroma = ch;
    }
  }
  return adapt(bestChroma >= 0.18 ? best : FALLBACK_ACCENT, p.primary);
}

// --- applying ---

/** Every var applyTheme writes, so a surface's text can be previewed. */
export interface SurfaceColors {
  bg: string;
  fg: string;
  fg2: string;
  fg3: string;
  border: string;
  hover: string;
}

export function surfaceOf(bg: string): SurfaceColors {
  const fg = fgFor(bg);
  return {
    bg,
    fg,
    fg2: mix(fg, bg, 0.78),
    fg3: mix(fg, bg, 0.55),
    border: mix(fg, bg, 0.2),
    hover: mix(fg, bg, 0.14),
  };
}

/**
 * Write the preset onto :root as CSS custom properties. App.css re-points
 * --text-* / --border / --bg-hover per surface from the --*-on-secondary and
 * --*-on-tertiary vars, so each panel's text follows its own background.
 */
export function applyTheme(p: ThemePreset): void {
  const root = document.documentElement.style;
  const primary = surfaceOf(p.primary);
  const secondary = surfaceOf(p.secondary);
  const tertiary = surfaceOf(p.tertiary);
  const accent = pickAccent(p);

  const set = (k: string, v: string) => root.setProperty(k, v);

  set("--bg-primary", primary.bg);
  set("--bg-secondary", secondary.bg);
  set("--bg-tertiary", tertiary.bg);

  // Defaults are the main surface's; scoped rules override them per panel.
  set("--text-primary", primary.fg);
  set("--text-secondary", primary.fg2);
  set("--text-muted", primary.fg3);
  set("--border", primary.border);
  set("--bg-hover", primary.hover);
  set("--scrollbar", mix(primary.fg, primary.bg, 0.32));

  set("--fg-on-primary", primary.fg);
  set("--fg-on-primary-2", primary.fg2);
  set("--fg-on-primary-3", primary.fg3);
  set("--border-on-primary", primary.border);
  set("--hover-on-primary", primary.hover);

  set("--fg-on-secondary", secondary.fg);
  set("--fg-on-secondary-2", secondary.fg2);
  set("--fg-on-secondary-3", secondary.fg3);
  set("--border-on-secondary", secondary.border);
  set("--hover-on-secondary", secondary.hover);

  set("--fg-on-tertiary", tertiary.fg);
  set("--fg-on-tertiary-2", tertiary.fg2);
  set("--fg-on-tertiary-3", tertiary.fg3);
  set("--border-on-tertiary", tertiary.border);
  set("--hover-on-tertiary", tertiary.hover);

  set("--accent", accent);
  set("--accent-fg", fgFor(accent)); // text drawn on top of the accent
  set("--accent-green", adapt("#a6e3a1", primary.bg));
  set("--accent-red", adapt("#f38ba8", primary.bg));
  set("--accent-yellow", adapt("#f9e2af", primary.bg));

  document.documentElement.dataset.bfdTheme = isLightTheme(p) ? "light" : "dark";
}

// --- storage ---

function sanitize(raw: unknown): ThemePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const primary = typeof r.primary === "string" ? normalizeHex(r.primary) : null;
  const secondary = typeof r.secondary === "string" ? normalizeHex(r.secondary) : null;
  const tertiary = typeof r.tertiary === "string" ? normalizeHex(r.tertiary) : null;
  if (!name || !primary || !secondary || !tertiary) return null;
  return { name, primary, secondary, tertiary };
}

export function loadPresets(): ThemePreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [DEFAULT_PRESET];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [DEFAULT_PRESET];
    const clean = parsed
      .map(sanitize)
      .filter((p): p is ThemePreset => p !== null);
    return clean.length ? clean : [DEFAULT_PRESET];
  } catch {
    return [DEFAULT_PRESET];
  }
}

export function savePresets(list: ThemePreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

export function loadActivePreset(list: ThemePreset[]): ThemePreset {
  try {
    const name = localStorage.getItem(ACTIVE_KEY);
    const hit = name ? list.find((p) => p.name === name) : undefined;
    if (hit) return hit;
  } catch {
    /* storage unavailable */
  }
  return list[0] ?? DEFAULT_PRESET;
}

export function saveActivePreset(p: ThemePreset): void {
  try {
    localStorage.setItem(ACTIVE_KEY, p.name);
  } catch {
    /* storage unavailable */
  }
}
