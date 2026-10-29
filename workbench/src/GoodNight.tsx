import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Good Night (v0.18.0): one button that closes out the day.
//
//   1. flush every modified editor tab to disk
//   2. write the session transcript + refresh the project's .bfd/context.md
//      ("Resume here" block, regenerated each night under a marker)
//   3. wait for outstanding agent tasks — headless `claude -p` bridges,
//      project python workers, mid-tick launchd daemons — to finish
//   4. commit + push every Turing project repo that is dirty or ahead
//   5. say Goodnight!
//
// Nothing here is speculative: every step reports what it actually did, and
// steps 3 and 4 report what they could not do rather than hiding it.

const HOME = "/Users/rowe";

// Repos Good Night is allowed to close out. Global memory's standing rule is
// one private repo per project folder, pushed right after every commit, so an
// unpushed commit in any of these is outstanding work by definition.
const KNOWN_REPOS = [
  "/Users/rowe/BFD",
  "/Users/rowe/DOX",
  "/Users/rowe/STOX",
  "/Users/rowe/EDUCASH",
];

// Blast-radius guard: a repo this dirty is a mistake (an unignored data dir, a
// bad merge), not a day's work. Flag it, never commit it.
const MAX_AUTO_COMMIT_FILES = 100;

const AGENT_WAIT_SECONDS = 120;
const AGENT_POLL_SECONDS = 5;

interface Cmd { stdout: string; stderr: string; exit_code: number }
interface GitResult { stdout: string; stderr: string; exit_code: number }
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

export interface GoodNightSession {
  cwd: string;
  model: string;
  modes: string;
  projectName: string;
  messages: { role: string; content: string }[];
  tabs: { name: string; path: string; modified: boolean }[];
}

type StepState = "pending" | "running" | "done" | "warn" | "fail";

interface Step {
  key: string;
  label: string;
  state: StepState;
  lines: string[];
}

const STEPS: Step[] = [
  { key: "files", label: "Save open files", state: "pending", lines: [] },
  { key: "context", label: "Save session context", state: "pending", lines: [] },
  { key: "agents", label: "Finish agent tasks", state: "pending", lines: [] },
  { key: "git", label: "Finish outstanding gits", state: "pending", lines: [] },
];

const DOT: Record<StepState, string> = {
  pending: "·",
  running: "…",
  done: "✓",
  warn: "!",
  fail: "✗",
};

async function sh(command: string, cwd?: string): Promise<Cmd> {
  return await invoke<Cmd>("run_command", { command, cwd });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function isoDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// Every live claude process, split into this app's own streaming sessions and
// the headless `-p` bridges other projects' daemons spawn. Only the bridges
// count as outstanding agent tasks: a stream-json process is a BFD window.
async function liveAgentTasks(): Promise<{ bridges: string[]; workers: string[]; daemons: string[] }> {
  const [procs, workers, daemons] = await Promise.all([
    sh(`ps -axo pid,etime,command | grep "[c]laude" || true`),
    sh(`ps -axo pid,etime,command | grep -E "[p]ython3?[[:space:]].*[.]py" || true`),
    sh(`launchctl list | grep -E "com\\.turing|com\\.rowe" || true`),
  ]);

  const bridges = procs.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("stream-json") && /(^|\s)(-p|--print)(\s|$)/.test(l));

  const workerLines = workers.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

  // A launchd job with a real pid is mid-tick; "-" means loaded but idle.
  const busyDaemons = daemons.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split(/\s+/);
      const pid = parts[0];
      const label = parts[parts.length - 1];
      return pid && pid !== "-" ? [`${label} (pid ${pid})`] : [];
    });

  return { bridges, workers: workerLines, daemons: busyDaemons };
}

export default function GoodNight({
  session,
  onSaveTabs,
  onClose,
}: {
  session: GoodNightSession;
  onSaveTabs: () => Promise<string[]>;
  onClose: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>(() => STEPS.map((s) => ({ ...s, lines: [] })));
  const [finished, setFinished] = useState(false);
  const [anyWarn, setAnyWarn] = useState(false);
  const started = useRef(false);

  function mark(key: string, state: StepState) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, state } : s)));
    if (state === "warn" || state === "fail") setAnyWarn(true);
  }

  function log(key: string, line: string) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, lines: [...s.lines, line] } : s)));
  }

  // StrictMode double-mounts in dev; the whole sequence writes files and
  // commits, so it runs exactly once per click.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, []);

  // --- Step 1: flush modified tabs -----------------------------------------
  async function stepFiles() {
    mark("files", "running");
    try {
      const saved = await onSaveTabs();
      if (saved.length === 0) log("files", "no unsaved tabs");
      else saved.forEach((n) => log("files", `saved ${n}`));
      mark("files", "done");
    } catch (e) {
      log("files", String(e));
      mark("files", "fail");
    }
  }

  // --- Step 2: session transcript + context.md ------------------------------
  // Walks up from the cwd for an existing .bfd/context.md, the same way the
  // Rust find_project_context does, so the session lands next to the context
  // the session was actually loaded with.
  async function findProjectRoot(): Promise<string> {
    let dir = session.cwd || HOME;
    for (let i = 0; i < 12 && dir && dir !== "/"; i++) {
      if (await invoke<boolean>("file_exists", { path: `${dir}/.bfd/context.md` })) return dir;
      dir = dir.split("/").slice(0, -1).join("/");
    }
    return session.cwd || HOME;
  }

  function transcript(now: Date, root: string, agents: string): string {
    const head = [
      `# BFD session — ${now.toLocaleString()}`,
      "",
      `- cwd: ${session.cwd}`,
      `- project: ${session.projectName || "(none)"} (${root})`,
      `- model: ${session.model}`,
      `- modes: ${session.modes}`,
      `- messages: ${session.messages.length}`,
      `- open tabs: ${session.tabs.length ? session.tabs.map((t) => t.name).join(", ") : "none"}`,
      "",
      "## Agents at close",
      "",
      agents || "- none running",
      "",
      "## Transcript",
      "",
    ];
    const body = session.messages.map(
      (m) => `### ${m.role === "user" ? "You" : "BFD"}\n\n${m.content}\n`
    );
    return head.join("\n") + (body.length ? body.join("\n") : "_(no messages this session)_\n");
  }

  // The tail of context.md below the marker is BFD's to rewrite: a rolling
  // session log (10 newest) plus a single Resume here block. Everything above
  // the marker is the user's and is never touched.
  function rebuildContext(existing: string, logLine: string, resume: string): string {
    const MARKER = "<!-- bfd:goodnight -->";
    const at = existing.indexOf(MARKER);
    const head = (at === -1 ? existing : existing.slice(0, at)).replace(/\s+$/, "");
    const tail = at === -1 ? "" : existing.slice(at + MARKER.length);
    const prior = tail.split("\n").filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l.trim()));
    const logLines = [logLine, ...prior].slice(0, 10);
    return [
      head,
      "",
      MARKER,
      "",
      "## Session log (newest first)",
      "",
      ...logLines,
      "",
      "## Resume here",
      "",
      resume,
      "",
    ].join("\n");
  }

  async function stepContext(agentsSummary: string): Promise<string> {
    mark("context", "running");
    try {
      const now = new Date();
      const root = await findProjectRoot();
      const dir = `${root}/.bfd/sessions`;
      await invoke("create_dir", { path: dir }).catch(() => {});
      const file = `${dir}/${stamp(now)}.md`;
      await invoke("write_file", { path: file, content: transcript(now, root, agentsSummary) });
      log("context", `transcript → ${file}`);

      const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
      const lastAsst = [...session.messages].reverse().find((m) => m.role === "assistant");
      const topic = lastUser ? clip(lastUser.content, 90) : "no chat this session";
      const logLine = `- ${isoDate(now)} ${now.toLocaleTimeString()} — ${session.messages.length} msgs — ${topic} — \`${file.replace(root + "/", "")}\``;
      const resume = [
        `_Written by Good Night, ${now.toLocaleString()} — ${session.messages.length} messages, model ${session.model}._`,
        "",
        `**Last ask:** ${lastUser ? clip(lastUser.content, 300) : "(none)"}`,
        "",
        `**Where it left off:** ${lastAsst ? clip(lastAsst.content, 700) : "(none)"}`,
        "",
        `**Full transcript:** \`${file}\``,
      ].join("\n");

      const ctxPath = `${root}/.bfd/context.md`;
      let existing = "";
      try {
        existing = await invoke<string>("read_file", { path: ctxPath });
      } catch {
        existing = `# ${session.projectName || root.split("/").pop() || "Project"}\n`;
        await invoke("create_dir", { path: `${root}/.bfd` }).catch(() => {});
      }
      await invoke("write_file", { path: ctxPath, content: rebuildContext(existing, logLine, resume) });
      log("context", `context.md updated — Resume here refreshed`);
      mark("context", "done");
      return root;
    } catch (e) {
      log("context", String(e));
      mark("context", "fail");
      return session.cwd;
    }
  }

  // --- Step 3: wait out the agent tasks ------------------------------------
  async function stepAgents(): Promise<string> {
    mark("agents", "running");
    const summary: string[] = [];
    try {
      let snap = await liveAgentTasks();
      const total = (s: typeof snap) => s.bridges.length + s.workers.length + s.daemons.length;

      if (total(snap) === 0) {
        log("agents", "nothing outstanding");
        mark("agents", "done");
        return "- none running";
      }

      snap.bridges.forEach((b) => log("agents", `claude bridge · ${clip(b, 110)}`));
      snap.workers.forEach((w) => log("agents", `worker · ${clip(w, 110)}`));
      snap.daemons.forEach((d) => log("agents", `daemon mid-tick · ${d}`));

      const deadline = Date.now() + AGENT_WAIT_SECONDS * 1000;
      while (total(snap) > 0 && Date.now() < deadline) {
        const left = Math.round((deadline - Date.now()) / 1000);
        log("agents", `waiting on ${total(snap)} task${total(snap) === 1 ? "" : "s"} — ${left}s left`);
        await sleep(AGENT_POLL_SECONDS * 1000);
        snap = await liveAgentTasks();
      }

      if (total(snap) === 0) {
        log("agents", "all agent tasks finished");
        mark("agents", "done");
        return "- all finished before close";
      }

      [...snap.bridges, ...snap.workers, ...snap.daemons].forEach((x) => summary.push(`- still running: ${clip(x, 160)}`));
      log("agents", `${total(snap)} still running after ${AGENT_WAIT_SECONDS}s — left alone, not killed`);
      mark("agents", "warn");
      return summary.join("\n");
    } catch (e) {
      log("agents", String(e));
      mark("agents", "fail");
      return `- snapshot failed: ${e}`;
    }
  }

  // --- Step 4: commit + push -----------------------------------------------
  async function git(repo: string, args: string[]): Promise<GitResult> {
    return await invoke<GitResult>("git_run", { repo, args });
  }

  // { ok: nothing left outstanding, acted: this repo produced any log line }
  async function closeRepo(repo: string, now: Date): Promise<{ ok: boolean; acted: boolean }> {
    let ov: GitOverview;
    try {
      ov = await invoke<GitOverview>("git_overview", { repo });
    } catch {
      return { ok: true, acted: false }; // not a repo / unreadable
    }
    if (!ov.is_repo || !ov.root) return { ok: true, acted: false };

    // Global memory: the stray ~/.git is never committed and never pushed.
    if (ov.root === HOME) {
      log("git", `${repo}: resolves to the home repo — skipped on purpose`);
      return { ok: true, acted: true };
    }

    const name = ov.root.split("/").pop() || ov.root;
    const changed = ov.changed ?? 0;
    const ahead = ov.ahead ?? 0;

    // git_overview counts tracked files only (-uno); untracked matter too.
    const st = await git(ov.root, ["status", "--porcelain"]);
    const dirtyFiles = st.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

    if (dirtyFiles.length === 0 && ahead === 0) return { ok: true, acted: false };

    if (dirtyFiles.length > MAX_AUTO_COMMIT_FILES) {
      log("git", `${name}: ${dirtyFiles.length} changed files (> ${MAX_AUTO_COMMIT_FILES}) — NOT committed, review by hand`);
      return { ok: false, acted: true };
    }

    let ok = true;
    if (dirtyFiles.length > 0) {
      log("git", `${name} ⎇ ${ov.branch} — ${dirtyFiles.length} change${dirtyFiles.length === 1 ? "" : "s"}${changed !== dirtyFiles.length ? ` (${changed} tracked)` : ""}`);
      dirtyFiles.slice(0, 8).forEach((f) => log("git", `   ${f}`));
      if (dirtyFiles.length > 8) log("git", `   …and ${dirtyFiles.length - 8} more`);

      const add = await git(ov.root, ["add", "-A"]);
      if (add.exit_code !== 0) {
        log("git", `${name}: add failed — ${clip(add.stderr, 160)}`);
        return { ok: false, acted: true };
      }
      const msg = `Good night — ${isoDate(now)} session wrap-up\n\nCommitted by BFD's Good Night button.`;
      const commit = await git(ov.root, ["commit", "-m", msg]);
      if (commit.exit_code === 0) log("git", `${name}: committed`);
      else if (/nothing to commit/i.test(commit.stdout + commit.stderr)) log("git", `${name}: nothing to commit after add`);
      else {
        log("git", `${name}: commit failed — ${clip(commit.stderr || commit.stdout, 160)}`);
        ok = false;
      }
    }

    if (!ov.remote) {
      log("git", `${name}: no origin remote — committed locally, not pushed`);
      return { ok: false, acted: true };
    }

    let push = await git(ov.root, ["push"]);
    if (push.exit_code !== 0 && /set-upstream|no upstream/i.test(push.stderr) && ov.branch) {
      push = await git(ov.root, ["push", "-u", "origin", ov.branch]);
    }
    if (push.exit_code === 0) {
      log("git", `${name}: pushed`);
      return { ok, acted: true };
    }
    log("git", `${name}: push failed — ${clip(push.stderr || push.stdout, 160)}`);
    return { ok: false, acted: true };
  }

  async function stepGit(projectRoot: string) {
    mark("git", "running");
    const now = new Date();
    const repos = [projectRoot, ...KNOWN_REPOS].filter((r, i, a) => r && a.indexOf(r) === i);
    let clean = true;
    let acted = false;
    try {
      for (const repo of repos) {
        if (!(await invoke<boolean>("file_exists", { path: `${repo}/.git` }))) continue;
        const r = await closeRepo(repo, now);
        if (!r.ok) clean = false;
        if (r.acted) acted = true;
      }
      if (!acted) log("git", "every repo already clean and pushed");
      mark("git", clean ? "done" : "warn");
    } catch (e) {
      log("git", String(e));
      mark("git", "fail");
    }
  }

  async function run() {
    await stepFiles();
    const agentsSummary = await stepAgents();
    const projectRoot = await stepContext(agentsSummary);
    await stepGit(projectRoot);
    setFinished(true);
  }

  return (
    <div className="goodnight-overlay">
      <div className="goodnight-card">
        <div className="goodnight-header">🌙 Good Night</div>

        <div className="goodnight-steps">
          {steps.map((s) => (
            <div key={s.key} className={`goodnight-step ${s.state}`}>
              <div className="goodnight-step-label">
                <span className="goodnight-dot">{DOT[s.state]}</span>
                {s.label}
              </div>
              {s.lines.length > 0 && (
                <div className="goodnight-step-lines">
                  {s.lines.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {finished ? (
          <div className="goodnight-done">
            <div className="goodnight-bye">Goodnight!</div>
            {anyWarn && <div className="goodnight-caveat">Some items need a look — see the flagged steps above.</div>}
            <button className="goodnight-close" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <div className="goodnight-working">working…</div>
        )}
      </div>
    </div>
  );
}
