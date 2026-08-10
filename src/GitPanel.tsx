import { useState, useEffect, useCallback, CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";

// Sidebar Git panel (v0.11.0). Talks to the git_overview/git_run commands in
// lib.rs; if the running binary predates them, it shows a relaunch notice
// instead of erroring (same graceful degradation as the pre-0.9.0 chat path).

interface GitOverview {
  is_repo: boolean;
  root?: string;
  branch?: string;
  changed?: number;
  last_commit?: string;
  remote?: string | null;
  ahead?: number;
  behind?: number;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

const btn: CSSProperties = {
  fontSize: 11,
  padding: "2px 7px",
  background: "#2d2d2d",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  width: "100%",
  fontSize: 11,
  padding: "3px 6px",
  background: "#1a1a1a",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 4,
  boxSizing: "border-box",
};

const muted: CSSProperties = { color: "var(--text-muted)", lineHeight: 1.5 };

export default function GitPanel({ currentDir }: { currentDir: string }) {
  const [open, setOpen] = useState(true);
  const [ov, setOv] = useState<GitOverview | null>(null);
  const [output, setOutput] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentDir) return;
    try {
      setOv(await invoke<GitOverview>("git_overview", { repo: currentDir }));
      setUnsupported(false);
    } catch (err) {
      if (String(err).includes("git_overview")) setUnsupported(true);
      else setOutput(String(err));
    }
  }, [currentDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(args: string[]): Promise<GitResult | null> {
    setBusy(true);
    try {
      const r = await invoke<GitResult>("git_run", { repo: ov?.root || currentDir, args });
      const text = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      setOutput(`$ git ${args.join(" ")}\n${text || `(ok, exit ${r.exit_code})`}`);
      await refresh();
      return r;
    } catch (err) {
      setOutput(String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function commitAll() {
    const msg = commitMsg.trim();
    if (!msg) return;
    const add = await run(["add", "-A"]);
    if (!add || add.exit_code !== 0) return;
    const r = await run(["commit", "-m", msg]);
    if (r?.exit_code === 0) setCommitMsg("");
  }

  // Push; if the branch has no upstream yet, retry once with -u origin <branch>.
  async function push() {
    const r = await run(["push"]);
    if (r && r.exit_code !== 0 && /set-upstream|no upstream/i.test(r.stderr) && ov?.branch) {
      await run(["push", "-u", "origin", ov.branch]);
    }
  }

  return (
    <div style={{ borderTop: "1px solid #333" }}>
      <div
        className="sidebar-header"
        style={{ cursor: "pointer" }}
        onClick={() => {
          if (!open) refresh();
          setOpen(!open);
        }}
      >
        {open ? "▾" : "▸"} Git{ov?.is_repo && ov.branch ? ` — ⎇ ${ov.branch}` : ""}
      </div>
      {open && (
        <div style={{ padding: "4px 10px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 6 }}>
          {unsupported ? (
            <div style={muted}>Git backend built — quit and relaunch BFD.app to enable it.</div>
          ) : !ov ? (
            <div style={muted}>…</div>
          ) : !ov.is_repo ? (
            <>
              <div style={muted}>Not a git repo.</div>
              <button style={btn} disabled={busy} onClick={() => run(["init", "-b", "main"])}>
                Init repo here
              </button>
            </>
          ) : (
            <>
              <div style={muted}>
                {ov.changed ? `${ov.changed} modified` : "clean"}
                {ov.ahead ? ` · ↑${ov.ahead}` : ""}
                {ov.behind ? ` · ↓${ov.behind}` : ""}
                <br />
                {ov.last_commit || "no commits yet"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <button style={btn} disabled={busy} onClick={() => run(["status", "--short"])}>Status</button>
                <button style={btn} disabled={busy} onClick={() => run(["log", "--oneline", "-10"])}>Log</button>
                <button style={btn} disabled={busy} onClick={() => run(["diff", "--stat"])}>Diff</button>
                {ov.remote && <button style={btn} disabled={busy} onClick={() => run(["pull"])}>Pull</button>}
                {ov.remote && <button style={btn} disabled={busy} onClick={push}>Push</button>}
                <button style={btn} disabled={busy} onClick={refresh} title="Refresh">⟳</button>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  style={inputStyle}
                  placeholder="Commit message…"
                  value={commitMsg}
                  disabled={busy}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitAll();
                  }}
                />
                <button style={btn} disabled={busy || !commitMsg.trim()} onClick={commitAll}>
                  Commit
                </button>
              </div>
              {!ov.remote && (
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    style={inputStyle}
                    placeholder="Remote URL (origin)…"
                    value={remoteUrl}
                    disabled={busy}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                  />
                  <button
                    style={btn}
                    disabled={busy || !remoteUrl.trim()}
                    onClick={async () => {
                      const r = await run(["remote", "add", "origin", remoteUrl.trim()]);
                      if (r?.exit_code === 0) setRemoteUrl("");
                    }}
                  >
                    Set
                  </button>
                </div>
              )}
            </>
          )}
          {output && (
            <pre
              style={{
                margin: 0,
                padding: 6,
                maxHeight: 140,
                overflow: "auto",
                fontSize: 10,
                lineHeight: 1.4,
                background: "#111",
                border: "1px solid #333",
                borderRadius: 4,
                whiteSpace: "pre-wrap",
              }}
            >
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
