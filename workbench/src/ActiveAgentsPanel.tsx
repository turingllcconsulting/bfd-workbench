import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Active Agents (v0.15.0): a snapshot of every agent-shaped thing currently
// running in the background, plus the AGENTS.md registry cross-referenced
// against what's actually alive. Read-only: data loads once on open and only
// changes when ⟳ Refresh is pressed.
const AGENTS_REGISTRY_PATH = "/Users/rowe/BFD/workbench/AGENTS.md";

// "Other workers" card: processes matching this pattern (any python script by
// default). Extend it to match your own projects' background workers.
const WORKER_PATTERN = "[p]ython3?[[:space:]].*[.]py";

interface Cmd { stdout: string; stderr: string; exit_code: number }
interface DaemonRow { label: string; pid: string | null; lastExit: string }
interface ClaudeRow { pid: string; etime: string; kind: string; command: string }
interface RegistryEntry { kind: string; name: string; body: string }

async function sh(command: string): Promise<Cmd> {
  return await invoke<Cmd>("run_command", { command });
}

function parseAgentRegistry(md: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const re = /^##\s+(Project|Agent Group):\s*(.+)$/gm;
  const matches = [...md.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? md.length : md.length;
    entries.push({ kind: m[1], name: m[2].trim(), body: md.slice(start, end).trim() });
  }
  return entries;
}

// Best-effort cross-reference: does anything alive right now look like it
// belongs to this registry entry? Matched by substring on the entry's name,
// against daemon labels, classified claude commands, and worker process lines.
function statusFor(entry: RegistryEntry, daemons: DaemonRow[], claude: ClaudeRow[], workers: string[]): string {
  const key = entry.name.toLowerCase();
  const daemonHit = daemons.find(d => d.label.toLowerCase().includes(key));
  if (daemonHit) return daemonHit.pid ? `running now (pid ${daemonHit.pid})` : "daemon loaded, idle between ticks";
  const workerHit = workers.find(w => w.toLowerCase().includes(key));
  if (workerHit) return "worker process active";
  const procHit = claude.find(c => c.command.toLowerCase().includes(key));
  if (procHit) return `claude process active (${procHit.kind}, pid ${procHit.pid})`;
  return "no background process detected";
}

export default function ActiveAgentsPanel({ onOpenFile }: { onOpenFile: (name: string, path: string) => void }) {
  const [daemons, setDaemons] = useState<DaemonRow[]>([]);
  const [claudeProcs, setClaudeProcs] = useState<ClaudeRow[]>([]);
  const [workers, setWorkers] = useState<string[]>([]);
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [takenAt, setTakenAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => { refresh(); }, []);

  async function fetchDaemons(): Promise<DaemonRow[]> {
    const r = await sh(`launchctl list | grep -E "com\\.turing|com\\.rowe" || true`);
    return r.stdout.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      const [pid, exit, ...labelParts] = parts;
      return {
        label: labelParts.join(" ") || parts[parts.length - 1] || "?",
        pid: pid === "-" ? null : pid,
        lastExit: exit ?? "?",
      };
    });
  }

  // Every live `claude` process on the machine, classified by command shape:
  // BFD's own stream-json sessions vs. headless `-p`/`--print` bridge calls
  // that other projects' daemons spawn.
  async function fetchClaudeProcs(): Promise<ClaudeRow[]> {
    const r = await sh(`ps -axo pid,etime,command | grep "[c]laude" || true`);
    return r.stdout.split("\n").map(l => l.trim()).filter(Boolean).flatMap(line => {
      const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) return [];
      const [, pid, etime, command] = m;
      const kind = command.includes("stream-json")
        ? "BFD session"
        : /(^|\s)(-p|--print)(\s|$)/.test(command)
        ? "headless bridge"
        : "other";
      return [{ pid, etime, kind, command }];
    });
  }

  async function fetchWorkers(): Promise<string[]> {
    const r = await sh(`ps -axo pid,etime,command | grep -E "${WORKER_PATTERN}" || true`);
    return r.stdout.split("\n").map(l => l.trim()).filter(Boolean);
  }

  async function fetchRegistry(): Promise<RegistryEntry[]> {
    const md = await invoke<string>("read_file", { path: AGENTS_REGISTRY_PATH });
    return parseAgentRegistry(md);
  }

  async function refresh() {
    setLoading(true);
    const errs: string[] = [];
    const grab = <T,>(p: Promise<T>, apply: (v: T) => void, label: string) =>
      p.then(apply).catch(e => { errs.push(`${label}: ${e}`); });

    await Promise.all([
      grab(fetchDaemons(), setDaemons, "daemons"),
      grab(fetchClaudeProcs(), setClaudeProcs, "claude procs"),
      grab(fetchWorkers(), setWorkers, "workers"),
      grab(fetchRegistry(), setRegistry, "registry"),
    ]);

    setErrors(errs);
    setTakenAt(new Date().toLocaleTimeString());
    setLoading(false);
  }

  const liveCount = daemons.filter(d => d.pid).length
    + claudeProcs.length
    + workers.length;

  return (
    <div className="agents-panel">
      <div className="agents-toolbar">
        <button className="agents-chip" onClick={refresh} title="Take a fresh snapshot">⟳ Refresh</button>
        <span className="bg-stamp">{loading ? "taking snapshot…" : `snapshot ${takenAt}`}</span>
        <span style={{ flex: 1 }} />
        <button className="agents-chip" onClick={() => onOpenFile("AGENTS.md", AGENTS_REGISTRY_PATH)} title="Open the agents registry in an editor tab">
          📄 AGENTS.md
        </button>
      </div>

      {errors.map((e, i) => <div key={i} className="agents-error">{e}</div>)}

      {loading && !takenAt ? (
        <div className="agents-empty">Taking first snapshot…</div>
      ) : (
        <div className="bg-cards">
          <div className="bg-card">
            <h3>Launchd daemons</h3>
            <div className="bg-kv"><span className="k">com.turing.* / com.rowe.*</span>{daemons.length || "none loaded"}</div>
            {daemons.map((d, i) => (
              <div key={i} className="bg-kv">
                <span className={`bg-dot ${d.pid ? "ok" : ""}`} />
                {d.label} — {d.pid ? `running (pid ${d.pid})` : `idle (last exit ${d.lastExit})`}
              </div>
            ))}
            {daemons.length === 0 && <div className="bg-note">no Turing launchd jobs found</div>}
          </div>

          <div className="bg-card">
            <h3>Claude processes</h3>
            <div className="bg-kv"><span className="k">live now</span>{claudeProcs.length || "none"}</div>
            {claudeProcs.map((p, i) => (
              <div key={i} className="bg-proc" title={p.command}>
                [{p.kind}] pid {p.pid} · {p.etime} · {p.command.slice(0, 90)}
              </div>
            ))}
          </div>

          <div className="bg-card">
            <h3>Other workers</h3>
            <div className="bg-kv"><span className="k">python</span>{workers.length || "none"}</div>
            {workers.map((w, i) => <div key={i} className="bg-proc" title={w}>{w.slice(0, 110)}</div>)}
            {workers.length === 0 && <div className="bg-note">no matching worker processes found</div>}
          </div>

          <div className="bg-card wide">
            <h3>Registry — projects &amp; agent groups</h3>
            <table className="agents-table">
              <thead><tr><th>Kind</th><th>Name</th><th>Status</th></tr></thead>
              <tbody>
                {registry.map((entry, i) => {
                  const status = statusFor(entry, daemons, claudeProcs, workers);
                  const ok = status !== "no background process detected";
                  return (
                    <tr key={i}>
                      <td>{entry.kind}</td>
                      <td>{entry.name}</td>
                      <td className="bg-status"><span className={`bg-dot ${ok ? "ok" : ""}`} />{status}</td>
                    </tr>
                  );
                })}
                {registry.length === 0 && (
                  <tr><td colSpan={3}>No categories found in AGENTS.md.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="agents-footnote">
        snapshots only — nothing auto-refreshes · {liveCount} process{liveCount === 1 ? "" : "es"} detected · registry {AGENTS_REGISTRY_PATH}
      </div>
    </div>
  );
}
