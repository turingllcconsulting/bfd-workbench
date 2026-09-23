// --- Color preset picker (v0.16.0) ---
// The "C" button in the title bar opens this. Pick a saved preset or build a
// new one from three hex values; Apply repaints the window immediately.

import { useState, KeyboardEvent } from "react";
import {
  ThemePreset,
  normalizeHex,
  surfaceOf,
  loadActivePreset,
} from "./theme";

interface ThemePickerProps {
  presets: ThemePreset[];
  active: ThemePreset;
  onApply: (p: ThemePreset) => void;
  onPresetsChange: (list: ThemePreset[]) => void;
  onClose: () => void;
}

interface Draft {
  name: string;
  primary: string;
  secondary: string;
  tertiary: string;
}

const BLANK: Draft = { name: "", primary: "#1e1e2e", secondary: "#181825", tertiary: "#11111b" };

type Slot = "primary" | "secondary" | "tertiary";

const SLOTS: { key: Slot; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "tertiary", label: "Tertiary" },
];

function Swatches({ p }: { p: ThemePreset }) {
  return (
    <span className="theme-swatches">
      {[p.primary, p.secondary, p.tertiary].map((c, i) => (
        <span key={i} className="theme-swatch" style={{ background: c }} />
      ))}
    </span>
  );
}

function ThemePicker({ presets, active, onApply, onPresetsChange, onClose }: ThemePickerProps) {
  const [draft, setDraft] = useState<Draft>({ ...active });
  // The saved preset currently loaded in the form, if any — enables Delete.
  const [editing, setEditing] = useState<string | null>(active.name || null);

  const parsed = {
    primary: normalizeHex(draft.primary),
    secondary: normalizeHex(draft.secondary),
    tertiary: normalizeHex(draft.tertiary),
  };
  const valid = !!(parsed.primary && parsed.secondary && parsed.tertiary);
  const named = draft.name.trim().length > 0;

  function edit(slot: Slot, value: string) {
    setDraft({ ...draft, [slot]: value });
  }

  function loadPreset(p: ThemePreset) {
    setDraft({ ...p });
    setEditing(p.name);
  }

  function startNew() {
    setDraft({ ...BLANK, name: "" });
    setEditing(null);
  }

  // Apply repaints instantly. A named draft is also saved (upsert by name), so
  // "create a new one" and "apply it" are the same click.
  function apply() {
    if (!valid) return;
    const name = draft.name.trim();
    const preset: ThemePreset = {
      name: name || "Unsaved",
      primary: parsed.primary!,
      secondary: parsed.secondary!,
      tertiary: parsed.tertiary!,
    };
    if (name) {
      const idx = presets.findIndex((p) => p.name === name);
      const next = [...presets];
      if (idx >= 0) next[idx] = preset;
      else next.push(preset);
      onPresetsChange(next);
      setEditing(name);
    }
    onApply(preset);
  }

  function remove(name: string) {
    const next = presets.filter((p) => p.name !== name);
    onPresetsChange(next);
    if (editing === name) {
      setEditing(null);
      setDraft({ ...loadActivePreset(next), name: "" });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && valid) apply();
  }

  const preview = valid
    ? { primary: surfaceOf(parsed.primary!), secondary: surfaceOf(parsed.secondary!), tertiary: surfaceOf(parsed.tertiary!) }
    : null;

  return (
    <div className="agent-picker-overlay" onClick={onClose}>
      <div className="agent-picker theme-picker" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="agent-picker-header">Color presets</div>

        {presets.length === 0 ? (
          <div className="agent-picker-empty">No presets saved yet.</div>
        ) : (
          presets.map((p) => (
            <div key={p.name} className={`theme-row ${p.name === active.name ? "active" : ""}`}>
              <button className="theme-row-main" onClick={() => loadPreset(p)} title="Load into the editor below">
                <span className="theme-row-dot">{p.name === active.name ? "●" : ""}</span>
                <span className="theme-row-name">{p.name}</span>
                <Swatches p={p} />
              </button>
              <button className="theme-row-apply" onClick={() => onApply(p)} title={`Apply ${p.name}`}>Apply</button>
              <button className="theme-row-del" onClick={() => remove(p.name)} title={`Delete ${p.name}`}>✕</button>
            </div>
          ))
        )}

        <button className="agent-picker-item agent-picker-new" onClick={startNew}>
          <span className="agent-picker-kind">+</span>
          <span className="agent-picker-name">New preset</span>
        </button>

        <div className="theme-form">
          <label className="theme-field">
            <span className="theme-field-label">Name</span>
            <input
              className="theme-input"
              value={draft.name}
              placeholder="My theme"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>

          {SLOTS.map(({ key, label }) => {
            const ok = parsed[key];
            return (
              <label key={key} className="theme-field">
                <span className="theme-field-label">{label}</span>
                <input
                  className={`theme-input theme-hex ${ok ? "" : "invalid"}`}
                  value={draft[key]}
                  placeholder="#1e1e2e"
                  spellCheck={false}
                  onChange={(e) => edit(key, e.target.value)}
                />
                <input
                  className="theme-color"
                  type="color"
                  value={ok ?? "#000000"}
                  onChange={(e) => edit(key, e.target.value)}
                  title={`Pick ${label}`}
                />
              </label>
            );
          })}

          {preview && (
            <div className="theme-preview">
              {(["primary", "secondary", "tertiary"] as Slot[]).map((slot) => {
                const s = preview[slot];
                return (
                  <div key={slot} className="theme-preview-cell" style={{ background: s.bg, color: s.fg, borderColor: s.border }}>
                    <strong>Aa</strong>
                    <span style={{ color: s.fg3 }}>{slot}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="theme-actions">
            <span className="theme-hint">
              {!valid ? "Hex values only — #rgb or #rrggbb" : named ? "Apply saves this preset too" : "Unnamed: applies without saving"}
            </span>
            {editing && (
              <button className="theme-btn" onClick={() => remove(editing)}>Delete</button>
            )}
            <button className="theme-btn primary" disabled={!valid} onClick={apply}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ThemePicker;
