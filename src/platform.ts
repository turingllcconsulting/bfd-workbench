// Host-OS facts, resolved once at startup from the Rust `platform_info` command.
//
// Nothing in the UI may assume "/" as a separator or a hardcoded home directory:
// on Windows the home is `C:\Users\<name>` and paths come back from `list_dir`
// with backslashes. Every path the frontend builds or splits goes through the
// helpers here.

import { invoke } from "@tauri-apps/api/core";

export interface PlatformInfo {
  os: string; // "macos" | "windows" | "linux"
  sep: string; // "/" or "\\"
  home: string;
  is_windows: boolean;
}

const FALLBACK: PlatformInfo = { os: "unknown", sep: "/", home: "", is_windows: false };

let info: PlatformInfo = FALLBACK;
let pending: Promise<PlatformInfo> | null = null;

/// Idempotent — safe to await from anywhere; only the first call hits Rust.
export function initPlatform(): Promise<PlatformInfo> {
  if (!pending) {
    pending = invoke<PlatformInfo>("platform_info")
      .then((p) => (info = { ...FALLBACK, ...p }))
      .catch(() => info);
  }
  return pending;
}

export function platform(): PlatformInfo {
  return info;
}

export function homeDir(): string {
  return info.home;
}

/// Join path segments with the host separator, tolerating segments that already
/// carry a leading or trailing one.
export function joinPath(...parts: string[]): string {
  const sep = info.sep;
  return parts
    .filter((p) => p !== "" && p != null)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

/// Last path segment. Splits on both separators because a path may arrive from
/// a config file authored on the other OS.
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/// Everything before the last segment; "" when there is no parent.
export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return "";
  return p.slice(0, idx);
}

/// `~/.bfd/<...>` — where BFD keeps global memory, agents, and startup config.
export function bfdPath(...parts: string[]): string {
  return joinPath(info.home, ".bfd", ...parts);
}
