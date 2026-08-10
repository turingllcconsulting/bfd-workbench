import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import GitPanel from "./GitPanel";
import { initPlatform, platform, homeDir, joinPath, basename, dirname, bfdPath } from "./platform";
import "./App.css";

export const BFD_VERSION = "1.0.0";

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : String(children ?? "");

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="code-block-wrapper">
      <button className="copy-btn" onClick={copy}>{copied ? "✓" : "Copy"}</button>
      <pre><code className={className}>{children}</code></pre>
    </div>
  );
}

// --- Types ---
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface FileTab {
  name: string;
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

// --- Config ---
// The Claude CLI has no --fast flag in --print mode; speed variants map to
// --effort levels instead (Fast = low, default = CLI default, Max = max).
interface ModelOption {
  key: string;
  id: string;
  effort: string | null;
  name: string;
}

const MODELS: ModelOption[] = [
  { key: "sonnet5", id: "claude-sonnet-5", effort: null, name: "Claude Sonnet 5" },
  { key: "sonnet5-fast", id: "claude-sonnet-5", effort: "low", name: "Claude Sonnet 5 - Fast" },
  { key: "sonnet5-max", id: "claude-sonnet-5", effort: "max", name: "Claude Sonnet 5 - Max" },
  { key: "opus5", id: "claude-opus-5", effort: null, name: "Claude Opus 5" },
  { key: "opus5-fast", id: "claude-opus-5", effort: "low", name: "Claude Opus 5 - Fast" },
  { key: "opus5-max", id: "claude-opus-5", effort: "max", name: "Claude Opus 5 - Max" },
  { key: "opus48", id: "claude-opus-4-8", effort: null, name: "Claude Opus 4.8" },
  { key: "opus48-fast", id: "claude-opus-4-8", effort: "low", name: "Claude Opus 4.8 - Fast" },
  { key: "opus48-max", id: "claude-opus-4-8", effort: "max", name: "Claude Opus 4.8 - Max" },
  { key: "sonnet46", id: "claude-sonnet-4-6", effort: null, name: "Claude Sonnet 4.6" },
  { key: "sonnet46-fast", id: "claude-sonnet-4-6", effort: "low", name: "Claude Sonnet 4.6 - Fast" },
  { key: "opus47", id: "claude-opus-4-7", effort: null, name: "Claude Opus 4.7" },
  { key: "opus47-fast", id: "claude-opus-4-7", effort: "low", name: "Claude Opus 4.7 - Fast" },
  { key: "opus47-max", id: "claude-opus-4-7", effort: "max", name: "Claude Opus 4.7 - Max" },
  { key: "haiku45", id: "claude-haiku-4-5-20251001", effort: null, name: "Claude Haiku 4.5" },
  { key: "fable5", id: "claude-fable-5", effort: null, name: "Fable 5" },
  { key: "fable5-fast", id: "claude-fable-5", effort: "low", name: "Fable 5 - Fast" },
  { key: "fable5-max", id: "claude-fable-5", effort: "max", name: "Fable 5 - Max" },
];

// --- Operating modes ---
// Three classes, radio-button behavior within each. The selection changes how
// the prompt/context is assembled for every subsequent send.
type MemoryMode = "standard" | "amnesia";
type InteractionMode = "chat" | "agent";
type ApprovalMode = "yolo" | "standard" | "caution";

interface Modes {
  memory: MemoryMode;
  interaction: InteractionMode;
  approval: ApprovalMode;
}

const DEFAULT_MODES: Modes = { memory: "standard", interaction: "chat", approval: "yolo" };
const MODES_STORAGE_KEY = "bfd-modes";

function loadStoredModes(): Modes {
  try {
    const raw = localStorage.getItem(MODES_STORAGE_KEY);
    if (!raw) return DEFAULT_MODES;
    const parsed = JSON.parse(raw);
    return {
      memory: parsed.memory === "amnesia" ? "amnesia" : "standard",
      interaction: parsed.interaction === "agent" ? "agent" : "chat",
      approval: parsed.approval === "standard" || parsed.approval === "caution" ? parsed.approval : "yolo",
    };
  } catch {
    return DEFAULT_MODES;
  }
}

// Where Agent mode looks for agent definition .md files, in order. Resolved at
// call time, not module load: the home directory is not known until the Rust
// platform_info round-trip completes.
function agentDirs(): string[] {
  return [joinPath(homeDir(), ".claude", "agents"), bfdPath("agents")];
}

// Tabs auto-opened on every launch, from ~/.bfd/startup_tabs.json. Each spec:
// { path } opens that exact file; { dir, limit } opens the newest files in
// dir; { dir, file, limit } opens dir/<newest subfolders>/file. "Newest" is a
// numeric-aware name sort — list_dir returns no mtime, but ISO-date filenames
// and numbered folders both sort correctly by name.
// Absent config = no startup tabs, which is the default.
function startupTabsConfig(): string {
  return bfdPath("startup_tabs.json");
}

interface StartupTabSpec {
  path?: string;
  dir?: string;
  file?: string;
  limit?: number;
  exclude?: string[];
}

const APPROVAL_PROMPTS: Record<ApprovalMode, string> = {
  yolo: "",
  standard: `--- APPROVAL MODE: STANDARD ---
This mode OVERRIDES the CRITICAL RULES above wherever they conflict. Do not act immediately. For any request that involves changing state (writing or deleting files, running commands that modify anything, starting or killing processes), first reply with a short plan of what you intend to do and ask how to proceed. Only act after the user approves in a later message. Read-only work (reading files, listing directories, checking ports) is fine without asking.`,
  caution: `--- APPROVAL MODE: CAUTION ---
This mode OVERRIDES the CRITICAL RULES above wherever they conflict. Be maximally careful. First reply with a plan and ask how to proceed. Then, before EVERY individual meaningful action — each file write, each deletion, each command execution, each process start or kill — state exactly what you are about to do and wait for explicit confirmation in a later message. One action per confirmation; never batch unapproved actions. Read-only actions are allowed, but say what you read.`,
};

const AGENT_MODE_PROMPT = `--- INTERACTION MODE: AGENT ---
Agent mode is active. Your role in this mode is to help the user work with agent definitions: explain how to use the existing agents loaded below, help improve them, or help the user create a new project with new agents. Be proactive in guiding this discussion.`;

function agentKickoffPrompt(): string {
  return `[System: The user just switched BFD into Agent mode. Greet them and open the agent discussion. If agent definition files are loaded in your context, briefly list them (name + one-line purpose) and ask whether they want (a) help using or improving an existing agent, or (b) to create a new project with new agents. If NO agent files were found, say so, mention that agent .md files can be placed in ${agentDirs().join(" or ")}, and offer to create the first one or set up a new project with new agents. Keep it short and conversational.]`;
}

const TOOL_STATUS: Record<string, string> = {
  read_file: "Reading a file",
  write_file: "Writing a file",
  list_dir: "Looking at a folder",
  delete_file: "Deleting a file",
  file_exists: "Checking a file",
  run_command: "Running a command",
  run_background: "Starting a process",
  kill_port: "Freeing a port",
  check_port: "Checking a port",
};

// Native Claude CLI tools (stream-json events) → simplified activity labels
const CLI_TOOL_STATUS: Record<string, string> = {
  Read: "Reading", Write: "Writing", Edit: "Editing", NotebookEdit: "Editing",
  Bash: "Running a command", Grep: "Searching", Glob: "Searching",
  WebFetch: "Browsing the web", WebSearch: "Searching the web",
  Task: "Working on a subtask", Agent: "Working on a subtask",
  Skill: "Using a skill", ToolSearch: "Finding tools",
  TaskCreate: "Planning", TaskUpdate: "Planning", TodoWrite: "Planning",
};

function toolActivityLine(name: string, input: any): string {
  const base = CLI_TOOL_STATUS[name] || `Using ${name}`;
  const p = input?.file_path || input?.path || input?.notebook_path;
  if (typeof p === "string") return `${base} ${basename(p)}`;
  if (name === "Bash" && typeof input?.command === "string") {
    const c = input.command.replace(/\s+/g, " ");
    return `Running: ${c.length > 60 ? c.slice(0, 60) + "…" : c}`;
  }
  if (typeof input?.query === "string") return `${base}: ${input.query}`;
  if (typeof input?.url === "string") return `${base}: ${input.url}`;
  if (typeof input?.description === "string") return `${base}: ${input.description}`;
  return base;
}

function basePrompt(): string {
  const home = homeDir() || "the user's home directory";
  return `You are BFD, a local AI workbench assistant. You help with coding, data analysis, and general questions. Be helpful, concise, and practical.

You have access to the local file system via tools. Always use absolute paths. The user's home directory is ${home}.

CRITICAL RULES:
1. When asked to do something, DO IT immediately. Read the files you need, then act.
2. Never say "let me look" and then only list_dir. Read the actual files.
3. After completing tool calls, ALWAYS respond with a summary of what you found or did.
4. If debugging: read_file the relevant source files, diagnose, then write_file the fix.
5. If launching: kill_port first, then run_background. Don't just check — act.
6. Never call the same tool twice in a row with the same arguments.
7. Maximum 3 read operations before you must either act or respond with findings.

Memory files:
- Global: ${bfdPath("global.md")}
- Project context: .bfd/context.md in any project folder`;
}

export const TOOLS_SCHEMA = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates if doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories at the given path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory path" },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to delete" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_exists",
    description: "Check if a file or directory exists",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to check" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command. Returns stdout, stderr, and exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "run_background",
    description: "Start a long-running process in background (dev servers, watchers). Returns PID immediately.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run in background" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "kill_port",
    description: "Kill any process on a specific port.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Port number to kill" },
      },
      required: ["port"],
    },
  },
  {
    name: "check_port",
    description: "Check if a port is in use.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Port number to check" },
      },
      required: ["port"],
    },
  },
];

// --- Helpers ---
function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    py: "python", js: "javascript", ts: "typescript", tsx: "typescriptreact",
    jsx: "javascriptreact", rs: "rust", sql: "sql", r: "r", json: "json",
    md: "markdown", css: "css", html: "html", yml: "yaml", yaml: "yaml",
    sh: "shell", ps1: "powershell", cs: "csharp", xml: "xml", toml: "toml",
    csv: "plaintext", txt: "plaintext",
  };
  return map[ext] || "plaintext";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ModeGroup({ label, options, value, onSelect, disabled }: {
  label: string;
  options: { key: string; name: string; title: string }[];
  value: string;
  onSelect: (key: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mode-group">
      <span className="mode-group-label">{label}</span>
      <div className="mode-segment">
        {options.map((o) => (
          <button
            key={o.key}
            className={`mode-btn ${value === o.key ? "active" : ""}`}
            title={o.title}
            disabled={disabled}
            onClick={() => onSelect(o.key)}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- App ---
function App() {
  const [activeView, setActiveView] = useState<"chat" | "editor">("chat");
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTab, setActiveTab] = useState<number>(-1);
  const [modelKey, setModelKey] = useState(MODELS[0].key);
  const selectedModel = MODELS.find((m) => m.key === modelKey) ?? MODELS[0];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [apiHistory, setApiHistory] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [streamStart, setStreamStart] = useState<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState(`BFD v${BFD_VERSION}\nReady.\n`);
  const [terminalInput, setTerminalInput] = useState("");
  const [currentDir, setCurrentDir] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileEntry[]>>({});
  const [globalMemory, setGlobalMemory] = useState("");
  const [projectContext, setProjectContext] = useState("");
  const [projectName, setProjectName] = useState("");
  const [modes, setModes] = useState<Modes>(loadStoredModes);
  const [agentDocs, setAgentDocs] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const activeRequestId = useRef("");
  const stoppedRef = useRef(false);

  useEffect(() => {
    // Every path helper depends on platform_info (home dir + separator), so
    // nothing that builds a path may run before this resolves.
    initPlatform().then(() => {
      loadHomeDir();
      loadMemory();
      openStartupTabs();
      // Restored Agent mode: reload agent docs silently (no kickoff message).
      if (modes.interaction === "agent") loadAgentDocs();
    });
  }, []);

  useEffect(() => {
    try { localStorage.setItem(MODES_STORAGE_KEY, JSON.stringify(modes)); } catch { /* storage unavailable */ }
  }, [modes]);

  async function loadMemory() {
    try {
      const mem = await invoke<string>("load_global_memory");
      setGlobalMemory(mem);
      setTerminalOutput(prev => prev + "Global memory loaded.\n");
    } catch {
      setTerminalOutput(prev => prev + "No global memory found.\n");
    }
  }

  async function loadProjectContext(dir: string) {
    try {
      const ctx = await invoke<string>("find_project_context", { startPath: dir });
      setProjectContext(ctx);
      const match = ctx.match(/^#\s+(.+)/m);
      setProjectName(match ? match[1] : "Project");
    } catch {
      setProjectContext("");
      setProjectName("");
    }
  }

  // Reads agent definition .md files into context (not into visible tabs).
  async function loadAgentDocs(): Promise<string> {
    let docs = "";
    let count = 0;
    for (const dir of agentDirs()) {
      try {
        const entries = await invoke<FileEntry[]>("list_dir", { path: dir });
        for (const e of entries) {
          if (e.is_dir || !e.name.endsWith(".md") || count >= 10) continue;
          try {
            const content = await invoke<string>("read_file", { path: e.path });
            docs += `\n\n--- AGENT FILE: ${e.path} ---\n${content.slice(0, 6000)}`;
            count++;
          } catch { /* unreadable file — skip */ }
        }
      } catch { /* dir missing — skip */ }
    }
    setAgentDocs(docs);
    setTerminalOutput(prev => prev + (count ? `Agent mode: loaded ${count} agent file(s).\n` : "Agent mode: no agent .md files found.\n"));
    return docs;
  }

  // Overrides exist for the Agent-mode kickoff, which runs before the
  // setModes/setAgentDocs state updates have re-rendered.
  function buildSystemPrompt(modesOverride?: Modes, agentDocsOverride?: string): string {
    const m = modesOverride ?? modes;
    const docs = agentDocsOverride ?? agentDocs;
    let prompt = basePrompt();
    if (m.approval !== "yolo") prompt += "\n\n" + APPROVAL_PROMPTS[m.approval];
    if (m.memory === "standard") {
      if (globalMemory) prompt += "\n\n--- GLOBAL MEMORY ---\n" + globalMemory;
      if (projectContext) prompt += "\n\n--- PROJECT CONTEXT ---\n" + projectContext;
    }
    prompt += `\n\n--- CURRENT DIRECTORY ---\n${currentDir}`;
    if (m.interaction === "agent") {
      prompt += "\n\n" + AGENT_MODE_PROMPT;
      prompt += docs || `\n\n(No agent definition files were found in ${agentDirs().join(" or ")}.)`;
    }
    if (tabs.length > 0 && activeTab >= 0 && tabs[activeTab]) {
      const tab = tabs[activeTab];
      const lines = tab.content.split("\n").slice(0, 100).join("\n");
      prompt += `\n\n--- ACTIVE FILE: ${tab.path} ---\n\`\`\`\n${lines}\n\`\`\``;
    }
    return prompt;
  }

  // History that will actually be sent to the model. Amnesia sends none.
  function historyForModel(memory: MemoryMode): any[] {
    if (memory === "amnesia") return [];
    const clean: any[] = [];
    for (const msg of apiHistory) {
      if (msg.role === "user" || (msg.role === "assistant" && !msg.tool_calls)) {
        clean.push({ role: msg.role, content: msg.content || "" });
      }
    }
    return clean.slice(-10);
  }

  // In Amnesia the exchange is still recorded (transcript keeps working if the
  // user switches back to Standard); it just wasn't sent to the model above.
  function commitHistory(newApiHistory: any[] | undefined, memory: MemoryMode) {
    if (!newApiHistory) return;
    setApiHistory(memory === "amnesia" ? [...apiHistory, ...newApiHistory] : newApiHistory);
  }

  async function selectInteraction(mode: InteractionMode) {
    if (isStreaming || mode === modes.interaction) return;
    const newModes = { ...modes, interaction: mode };
    setModes(newModes);
    if (mode !== "agent") return;

    // Agent mode: load agent files into context, then have the assistant
    // proactively open the discussion. The kickoff instruction is sent as the
    // Human turn but never shown in the transcript.
    setIsStreaming(true);
    setStreamStart(Date.now());
    setStreamStatus("Loading agents");
    stoppedRef.current = false;
    const docs = await loadAgentDocs();
    const newApiHistory = await chatLoop([...messages], historyForModel(newModes.memory), {
      injectedUserText: agentKickoffPrompt(),
      modesOverride: newModes,
      agentDocsOverride: docs,
    });
    commitHistory(newApiHistory, newModes.memory);
    setStreamStatus("");
    setIsStreaming(false);
  }

  async function loadHomeDir() {
    try {
      const home = await invoke<string>("get_home_dir");
      setCurrentDir(home);
      loadDir(home);
      loadProjectContext(home);
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Could not resolve home directory: ${err}\n`);
    }
  }

  async function loadDir(path: string) {
    try {
      const entries = await invoke<FileEntry[]>("list_dir", { path });
      const visible = entries.filter(e => !e.name.startsWith("."));
      setFiles(visible);
      setCurrentDir(path);
      loadProjectContext(path);
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error loading dir: ${err}\n`);
    }
  }

  async function toggleDir(path: string) {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
      if (!dirChildren[path]) {
        try {
          const entries = await invoke<FileEntry[]>("list_dir", { path });
          const visible = entries.filter(e => !e.name.startsWith("."));
          setDirChildren(prev => ({ ...prev, [path]: visible }));
        } catch (err: any) {
          setTerminalOutput(prev => prev + `Error: ${err}\n`);
        }
      }
    }
    setExpandedDirs(newExpanded);
  }

  async function openFile(name: string, path: string) {
    const existing = tabs.findIndex(t => t.path === path);
    if (existing >= 0) { setActiveTab(existing); setActiveView("editor"); return; }
    try {
      const content = await invoke<string>("read_file", { path });
      const newTab: FileTab = { name, path, content, language: detectLanguage(name), modified: false };
      setTabs(prev => [...prev, newTab]);
      setActiveTab(tabs.length);
      setActiveView("editor");
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error opening file: ${err}\n`);
    }
  }

  // Batch version of openFile for launch: openFile in a loop would set
  // activeTab from a stale tabs closure, so all tabs are read first and
  // committed in one setTabs.
  async function openStartupTabs() {
    let specs: StartupTabSpec[] = [];
    try {
      const parsed = JSON.parse(await invoke<string>("read_file", { path: startupTabsConfig() }));
      specs = Array.isArray(parsed) ? parsed : parsed.tabs;
      if (!Array.isArray(specs)) return;
    } catch { return; /* no config — nothing to open */ }

    const newestFirst = (a: FileEntry, b: FileEntry) => b.name.localeCompare(a.name, undefined, { numeric: true });
    const targets: { name: string; path: string }[] = [];
    for (const spec of specs) {
      try {
        if (spec.path) {
          targets.push({ name: basename(spec.path), path: spec.path });
        } else if (spec.dir) {
          const entries = await invoke<FileEntry[]>("list_dir", { path: spec.dir });
          const excluded = new Set(spec.exclude ?? []);
          const picked = entries
            .filter(e => !e.name.startsWith(".") && !excluded.has(e.name) && (spec.file ? e.is_dir : !e.is_dir))
            .sort(newestFirst)
            .slice(0, spec.limit ?? 1);
          for (const e of picked) {
            targets.push(spec.file ? { name: e.name, path: joinPath(e.path, spec.file) } : { name: e.name, path: e.path });
          }
        }
      } catch { /* dir missing — skip this spec */ }
    }

    const opened: FileTab[] = [];
    for (const t of targets) {
      if (opened.some(o => o.path === t.path)) continue;
      try {
        const content = await invoke<string>("read_file", { path: t.path });
        opened.push({ name: t.name, path: t.path, content, language: detectLanguage(basename(t.path) || t.name), modified: false });
      } catch { /* listed but unreadable — skip */ }
    }
    if (opened.length === 0) return;
    setTabs(prev => [...prev, ...opened.filter(o => !prev.some(p => p.path === o.path))]);
    setActiveTab(0);
    setActiveView("editor");
    setTerminalOutput(prev => prev + `Startup tabs: ${opened.map(o => o.name).join(", ")}\n`);
  }

  async function saveFile(index: number) {
    const tab = tabs[index];
    if (!tab) return;
    try {
      await invoke("write_file", { path: tab.path, content: tab.content });
      const newTabs = [...tabs];
      newTabs[index] = { ...newTabs[index], modified: false };
      setTabs(newTabs);
      setTerminalOutput(prev => prev + `Saved: ${tab.path}\n`);
      if (tab.path.endsWith("global.md")) loadMemory();
      if (tab.path.endsWith("context.md")) loadProjectContext(currentDir);
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error saving: ${err}\n`);
    }
  }

  async function openFileDialog() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, filters: [{ name: "All Files", extensions: ["*"] }] });
      if (path && typeof path === "string") {
        const name = basename(path) || "untitled";
        await openFile(name, path);
      }
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error: ${err}\n`);
    }
  }

  async function createNewFile() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: currentDir + "/untitled.txt", filters: [{ name: "All Files", extensions: ["*"] }] });
      if (path) {
        await invoke("write_file", { path, content: "" });
        const name = basename(path) || "untitled";
        await openFile(name, path);
        loadDir(currentDir);
      }
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error: ${err}\n`);
    }
  }

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  // Grow the input up to 8 lines (8 × 20px line-height + 22px padding/border), then scroll
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 182) + "px";
  }, [chatInput]);
  useEffect(() => {
    if (!isStreaming) { setElapsed(0); return; }
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - streamStart) / 1000));
    }, 200);
    return () => clearInterval(interval);
  }, [isStreaming, streamStart]);
  useEffect(() => { terminalEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [terminalOutput]);

  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (activeTab >= 0 && tabs[activeTab]) saveFile(activeTab); }
      if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); openFileDialog(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") { e.preventDefault(); createNewFile(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, tabs, currentDir]);

  // --- Tool execution ---
  async function executeTool(name: string, args: any): Promise<string> {
    try {
      switch (name) {
        case "read_file": {
          const content = await invoke<string>("read_file", { path: args.path });
          return content;
        }
        case "write_file": {
          await invoke("write_file", { path: args.path, content: args.content });
          loadDir(currentDir);
          if (args.path.endsWith("global.md")) loadMemory();
          if (args.path.endsWith("context.md")) loadProjectContext(currentDir);
          return `File written successfully: ${args.path}`;
        }
        case "list_dir": {
          const entries = await invoke<FileEntry[]>("list_dir", { path: args.path });
          return entries.map(e => `${e.is_dir ? "[DIR]" : "[FILE]"} ${e.name} (${formatSize(e.size)})`).join("\n");
        }
        case "delete_file": {
          await invoke("delete_file", { path: args.path });
          loadDir(currentDir);
          return `Deleted: ${args.path}`;
        }
        case "file_exists": {
          const exists = await invoke<boolean>("file_exists", { path: args.path });
          return exists ? `Yes, ${args.path} exists.` : `No, ${args.path} does not exist.`;
        }
        case "kill_port": {
          const killResult = await invoke<string>("kill_port", { port: args.port });
          setTerminalOutput(prev => prev + `\nKilled port ${args.port}\n`);
          return killResult;
        }
        case "check_port": {
          const inUse = await invoke<boolean>("check_port", { port: args.port });
          return inUse ? `Port ${args.port} is IN USE` : `Port ${args.port} is free`;
        }
        case "run_background": {
          const bgResult = await invoke<string>("run_background", { command: args.command, cwd: args.cwd || currentDir });
          setTerminalOutput(prev => prev + `\n[bg] ${args.command}\n${bgResult}\n`);
          return bgResult;
        }
        case "run_command": {
          const result = await invoke<any>("run_command", { command: args.command, cwd: args.cwd || currentDir });
          let output = "";
          if (result.stdout) output += result.stdout;
          if (result.stderr) output += result.stderr;
          output += `\nExit code: ${result.exit_code}`;
          setTerminalOutput(prev => prev + `\n$ ${args.command}\n${result.stdout || ""}${result.stderr || ""}`);
          return output;
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err.toString()}`;
    }
  }

  // --- Chat via Claude CLI (streaming) ---
  async function sendMessage() {
    if (!chatInput.trim() || isStreaming) return;
    const userMsg: ChatMessage = { role: "user", content: chatInput.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setChatInput("");
    setIsStreaming(true);
    setStreamStart(Date.now());
    setStreamStatus("Thinking");
    stoppedRef.current = false;

    const newApiHistory = await chatLoop(newMessages, historyForModel(modes.memory));
    commitHistory(newApiHistory, modes.memory);
    setStreamStatus("");
    setIsStreaming(false);
  }

  async function stopStreaming() {
    stoppedRef.current = true;
    setStreamStatus("Stopping");
    try { await invoke("stop_claude", { requestId: activeRequestId.current }); } catch { /* nothing running or old binary */ }
  }

  // Pre-0.9.0 binary fallback: no run_claude_stream command yet. Pass the
  // prompt through a temp file so nothing from chat history reaches /bin/sh.
  async function legacyRound(prompt: string): Promise<{ text: string; exitCode: number; stderr: string }> {
    setStreamStatus("Working (relaunch BFD for live updates)");
    const tmp = `/tmp/bfd_prompt_${Date.now()}.txt`;
    await invoke("write_file", { path: tmp, content: prompt });
    const effortFlag = selectedModel.effort ? ` --effort ${selectedModel.effort}` : "";
    const cmd = `claude --model ${selectedModel.id}${effortFlag} --print < ${tmp} 2>/dev/null`;
    try {
      const result = await invoke<any>("run_command", { command: cmd, cwd: currentDir });
      return { text: (result.stdout || "").trim(), exitCode: result.exit_code ?? 0, stderr: result.stderr || "" };
    } finally {
      invoke("delete_file", { path: tmp }).catch(() => {});
    }
  }

  // One CLI round: spawn claude in stream-json mode, mirror its progress into
  // the chat as it happens, resolve with the round's full text.
  async function runClaudeRound(
    prompt: string,
    baseMessages: ChatMessage[],
    activity: string[],
  ): Promise<{ text: string; exitCode: number; stderr: string }> {
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    activeRequestId.current = requestId;
    const seenToolIds = new Set<string>();
    let acc = "";
    let resultText = "";
    let lastPaint = 0;

    const paint = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPaint < 100) return;
      lastPaint = now;
      // Hide raw tool-call JSON while it streams; the loop below handles it.
      const visible = acc.split("<tool_call>")[0].trimEnd();
      const body = activity.length
        ? activity.join("  \n") + (visible ? "\n\n" + visible : "")
        : visible;
      if (body.trim()) setMessages([...baseMessages, { role: "assistant", content: body }]);
    };

    const pushActivity = (line: string) => {
      if (activity[activity.length - 1] === line) return;
      activity.push(`▸ ${line}`);
      paint(true);
    };

    const unlisten = await listen<{ requestId: string; line: string }>("claude-stream", (event) => {
      if (event.payload.requestId !== requestId) return;
      let ev: any;
      try { ev = JSON.parse(event.payload.line); } catch { return; }

      if (ev.type === "stream_event") {
        const se = ev.event;
        if (se?.type === "content_block_start") {
          const cb = se.content_block;
          if (cb?.type === "tool_use") setStreamStatus(CLI_TOOL_STATUS[cb.name] || `Using ${cb.name}`);
          else if (cb?.type === "thinking") setStreamStatus("Thinking");
          else if (cb?.type === "text") {
            if (acc && !acc.endsWith("\n\n")) acc += "\n\n";
            setStreamStatus("Writing");
          }
        } else if (se?.type === "content_block_delta") {
          const d = se.delta;
          if (d?.type === "text_delta") { acc += d.text; setStreamStatus("Writing"); paint(); }
          else if (d?.type === "thinking_delta") setStreamStatus("Thinking");
        }
      } else if (ev.type === "assistant") {
        for (const block of ev.message?.content || []) {
          if (block.type === "tool_use" && !seenToolIds.has(block.id)) {
            seenToolIds.add(block.id);
            const line = toolActivityLine(block.name, block.input);
            setStreamStatus(line);
            pushActivity(line);
          }
        }
      } else if (ev.type === "system" && ev.subtype === "init") {
        setStreamStatus("Thinking");
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") resultText = ev.result;
      }
    });

    try {
      const res = await invoke<any>("run_claude_stream", {
        requestId,
        prompt,
        model: selectedModel.id,
        effort: selectedModel.effort,
        cwd: currentDir,
      });
      paint(true);
      return { text: acc.trim() || resultText.trim(), exitCode: res.exit_code ?? 0, stderr: res.stderr || "" };
    } catch (err: any) {
      // Old binary without the streaming command → degrade gracefully.
      if (String(err).includes("run_claude_stream")) return await legacyRound(prompt);
      throw err;
    } finally {
      unlisten();
    }
  }

  async function chatLoop(
    conversationMessages: ChatMessage[],
    prevApiHistory: any[] = [],
    opts?: { injectedUserText?: string; modesOverride?: Modes; agentDocsOverride?: string },
  ): Promise<any[]> {
    // The Human turn sent to the model; injectedUserText (mode kickoffs) is
    // sent but never displayed in the transcript.
    const humanText = opts?.injectedUserText ?? conversationMessages[conversationMessages.length - 1]?.content ?? "";
    const activity: string[] = [];
    let toolRounds = 0;
    const MAX_TOOL_ROUNDS = 5;

    // Build the prompt for Claude CLI
    const systemPrompt = buildSystemPrompt(opts?.modesOverride, opts?.agentDocsOverride);
    const historyText = prevApiHistory.map(m => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`).join("\n\n");
    let fullPrompt = systemPrompt;
    if (historyText) fullPrompt += "\n\n--- CONVERSATION HISTORY ---\n" + historyText;
    fullPrompt += "\n\nHuman: " + humanText;

    // Displayed message keeps the activity lines; apiHistory stays clean text.
    const finish = (content: string): any[] => {
      const body = activity.length
        ? activity.join("  \n") + (content ? "\n\n" + content : "")
        : content;
      setMessages([...conversationMessages, { role: "assistant", content: body }]);
      return [...prevApiHistory, { role: "user", content: humanText }, { role: "assistant", content }];
    };

    for (let iteration = 0; iteration < 20; iteration++) {
      try {
        setStreamStatus(toolRounds === 0 ? "Thinking" : "Working");
        const round = await runClaudeRound(fullPrompt, conversationMessages, activity);

        if (stoppedRef.current) {
          return finish(round.text ? round.text + "\n\n⏹ Stopped." : "⏹ Stopped.");
        }
        if (!round.text) {
          if (round.exitCode !== 0) {
            const tail = round.stderr.split("\n").filter(Boolean).slice(-3).join("\n");
            return finish(`⚠️ Claude CLI error (exit ${round.exitCode}).${tail ? "\n\n```\n" + tail + "\n```" : ""}`);
          }
          return finish("No response from Claude.");
        }

        const responseText = round.text;
        const toolCallMatch = responseText.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g);

        if (toolCallMatch && toolRounds < MAX_TOOL_ROUNDS) {
          toolRounds++;
          for (const tcBlock of toolCallMatch) {
            try {
              const jsonStr = tcBlock.replace(/<\/?tool_call>/g, "").trim();
              const tc = JSON.parse(jsonStr);
              const fnName = tc.name || tc.tool;
              const fnArgs = tc.arguments || tc.input || {};

              setStreamStatus(TOOL_STATUS[fnName] || `Running ${fnName}`);
              activity.push(`▸ ${TOOL_STATUS[fnName] || fnName}`);
              setMessages([...conversationMessages, { role: "assistant", content: activity.join("  \n") }]);

              const toolResult = await executeTool(fnName, fnArgs);
              fullPrompt += `\n\nTool ${fnName} result: ${toolResult}`;
            } catch {
              // Skip malformed tool calls
            }
          }
          if (stoppedRef.current) return finish("⏹ Stopped.");

          // Strip tool calls from response to get remaining text
          const textOnly = responseText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
          if (textOnly) return finish(textOnly);

          fullPrompt += "\n\nPlease respond with your final answer now.";
          continue;
        }

        return finish(responseText);
      } catch (err: any) {
        return finish(`Error: ${err.message || err}`);
      }
    }
    return finish("Max iterations reached.");
  }

  function handleChatKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function closeTab(index: number) {
    const newTabs = tabs.filter((_, i) => i !== index);
    setTabs(newTabs);
    if (activeTab >= newTabs.length) setActiveTab(newTabs.length - 1);
    if (newTabs.length === 0) setActiveView("chat");
  }

  function updateTabContent(index: number, content: string) {
    const newTabs = [...tabs];
    newTabs[index] = { ...newTabs[index], content, modified: true };
    setTabs(newTabs);
  }

  async function refreshTab(index: number) {
    const tab = tabs[index];
    if (!tab) return;
    try {
      const content = await invoke<string>("read_file", { path: tab.path });
      const newTabs = [...tabs];
      newTabs[index] = { ...newTabs[index], content, modified: false };
      setTabs(newTabs);
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Refresh failed: ${err}\n`);
    }
  }

  async function runTerminalCommand(cmd: string) {
    setTerminalOutput(prev => prev + `\n$ ${cmd}\n`);
    try {
      const result = await invoke<any>("run_command", { command: cmd, cwd: currentDir });
      setTerminalOutput(prev => prev + (result.stdout || "") + (result.stderr || "") + "\n");
    } catch (err: any) {
      setTerminalOutput(prev => prev + `Error: ${err}\n`);
    }
  }

  function handleTerminalKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && terminalInput.trim()) { runTerminalCommand(terminalInput.trim()); setTerminalInput(""); }
  }

  function renderFileTree(entries: FileEntry[], depth: number = 0) {
    return entries.map((entry) => (
      <div key={entry.path}>
        <div
          className={`file-item ${activeView === "editor" && tabs[activeTab]?.path === entry.path ? "active" : ""}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => { if (entry.is_dir) { toggleDir(entry.path); } else { openFile(entry.name, entry.path); } }}
        >
          <span>{entry.is_dir ? (expandedDirs.has(entry.path) ? "📂" : "📁") : "📄"}</span>
          <span style={{ flex: 1 }}>{entry.name}</span>
          {!entry.is_dir && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{formatSize(entry.size)}</span>}
        </div>
        {entry.is_dir && expandedDirs.has(entry.path) && dirChildren[entry.path] && renderFileTree(dirChildren[entry.path], depth + 1)}
      </div>
    ));
  }

  return (
    <div className="app-container">
      <div className="title-bar">
        <span className="title-bar-text">BFD</span>
        <div style={{ display: "flex", gap: 8, WebkitAppRegion: "no-drag" } as any}>
          <button className="title-btn" onClick={createNewFile} title="New File (⌘N)">+</button>
          <button className="title-btn" onClick={openFileDialog} title="Open File (⌘O)">📂</button>
          <button className="title-btn" onClick={() => activeTab >= 0 && saveFile(activeTab)} title="Save (⌘S)">💾</button>
          <button className="title-btn" onClick={() => activeTab >= 0 && refreshTab(activeTab)} title="Reload file from disk">⟳</button>
          <button className="title-btn" onClick={() => { loadMemory(); loadProjectContext(currentDir); }} title="Reload Memory">🧠</button>
          <span className="title-bar-text" style={{ fontSize: 11, opacity: 0.6 }}>
            {selectedModel.name}
          </span>
        </div>
      </div>

      <div className="mode-bar">
        <ModeGroup
          label="Memory"
          disabled={isStreaming}
          value={modes.memory}
          onSelect={(k) => setModes({ ...modes, memory: k as MemoryMode })}
          options={[
            { key: "standard", name: "Standard", title: "Conversation history and memory files are sent with every prompt" },
            { key: "amnesia", name: "Amnesia", title: "Every prompt is a fresh context: no history, no memory files" },
          ]}
        />
        <ModeGroup
          label="Interaction"
          disabled={isStreaming}
          value={modes.interaction}
          onSelect={(k) => selectInteraction(k as InteractionMode)}
          options={[
            { key: "chat", name: "Chat", title: "Normal conversational assistant" },
            { key: "agent", name: "Agent", title: "Load agent definitions and discuss using or creating agents" },
          ]}
        />
        <ModeGroup
          label="Approval"
          disabled={isStreaming}
          value={modes.approval}
          onSelect={(k) => setModes({ ...modes, approval: k as ApprovalMode })}
          options={[
            { key: "yolo", name: "YOLO", title: "Act immediately, never ask" },
            { key: "standard", name: "Standard", title: "Come back with a plan and ask before acting" },
            { key: "caution", name: "Caution", title: "Plan first, then confirm every meaningful action step by step" },
          ]}
        />
      </div>

      <div className="main-content">
        <div className="sidebar">
          <div className="sidebar-header">
            Explorer
            <span style={{ cursor: "pointer", float: "right" }} onClick={() => loadDir(currentDir)} title="Refresh">🔄</span>
          </div>
          <div className="file-tree">
            <div className={`file-item ${activeView === "chat" && activeTab === -1 ? "active" : ""}`} onClick={() => { setActiveView("chat"); setActiveTab(-1); }}>
              💬 Chat
            </div>
            <div className="sidebar-header" style={{ marginTop: 4, display: "flex", alignItems: "center" }}>
              <span style={{ cursor: "pointer", marginRight: 4 }} onClick={() => { const parent = dirname(currentDir); if (parent) loadDir(parent); }} title="Go up">⬆️</span>
              <span style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentDir}</span>
            </div>
            {renderFileTree(files)}
          </div>
          <GitPanel currentDir={currentDir} />
          <div className="model-selector">
            <select className="model-select" value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
              {MODELS.map((m) => (<option key={m.key} value={m.key}>{m.name}</option>))}
            </select>
          </div>
        </div>

        <div className="center-panel">
          <div className="tabs-bar">
            <div className={`tab ${activeView === "chat" ? "active" : ""}`} onClick={() => setActiveView("chat")}>💬 Chat</div>
            {tabs.map((tab, i) => (
              <div key={tab.path} className={`tab ${activeView === "editor" && activeTab === i ? "active" : ""}`} onClick={() => { setActiveTab(i); setActiveView("editor"); }}>
                {tab.modified ? "● " : ""}{tab.name}
                <span className="tab-refresh" title="Reload from disk" onClick={(e) => { e.stopPropagation(); refreshTab(i); }}>⟳</span>
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(i); }}>×</span>
              </div>
            ))}
          </div>

          <div className="editor-area">
            {activeView === "chat" ? (
              <div className="chat-container">
                <div className="chat-messages">
                  {messages.length === 0 && (
                    <div style={{ textAlign: "center", marginTop: 80 }}>
                      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>BFD</div>
                      <div style={{ color: "var(--text-muted)" }}>Powered by Claude CLI</div>
                      <div style={{ color: "var(--text-muted)", marginTop: 8, fontSize: 12 }}>
                        {globalMemory ? "🧠 Global memory loaded" : "⚠️ No global memory"}
                        {projectContext ? " | 📋 Project context loaded" : ""}
                      </div>
                      <div style={{ color: "var(--text-muted)", marginTop: 4, fontSize: 12 }}>⌘O Open | ⌘N New | ⌘S Save | Chat has file system access</div>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className="chat-message">
                      <div className={`role ${msg.role}`}>{msg.role === "user" ? "You" : "BFD"}</div>
                      <div className="content">{msg.role === "assistant" ? <ReactMarkdown components={{ pre: ({ children }) => <>{children}</>, code: ({ node, className, children, ...props }: any) => { const isBlock = !props.inline && (className || (typeof children === "string" && children.includes("\n"))); return isBlock ? <CodeBlock className={className}>{children}</CodeBlock> : <code className={className} {...props}>{children}</code>; } }}>{msg.content}</ReactMarkdown> : msg.content}</div>
                    </div>
                  ))}
                  {isStreaming && (
                    <div className="chat-status">
                      <span className="status-dot" />
                      <span className="status-text">{streamStatus || "Thinking"}…</span>
                      {elapsed > 0 && <span className="status-elapsed">{elapsed}s</span>}
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className="chat-input-area">
                  <textarea ref={chatInputRef} className="chat-input" placeholder="Ask BFD anything..." value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={handleChatKeyDown} rows={1} />
                  {isStreaming ? (
                    <button className="chat-send-btn stop-btn" onClick={stopStreaming}>Stop</button>
                  ) : (
                    <button className="chat-send-btn" onClick={sendMessage} disabled={!chatInput.trim()}>Send</button>
                  )}
                </div>
              </div>
            ) : (
              activeTab >= 0 && tabs[activeTab] && (
                <Editor height="100%" language={tabs[activeTab].language} value={tabs[activeTab].content} onChange={(v) => updateTabContent(activeTab, v || "")} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 14, lineNumbers: "on", wordWrap: "on", padding: { top: 8 }, scrollBeyondLastLine: false }} />
              )
            )}
          </div>

          <div className="terminal-container">
            <div className="terminal-header"><span>Terminal</span></div>
            <div className="terminal-output">{terminalOutput}<div ref={terminalEndRef} /></div>
            <div className="terminal-input-line">
              <span className="terminal-prompt">{platform().is_windows ? ">" : "$"}</span>
              <input className="terminal-input" value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} onKeyDown={handleTerminalKeyDown} placeholder="Enter command..." />
            </div>
          </div>
        </div>
      </div>

      <div className="status-bar">
        <span>BFD v{BFD_VERSION} — {currentDir}</span>
        <span>
          {globalMemory ? "🧠" : ""}
          {projectContext ? ` 📋 ${projectName || "Project"}` : ""}
          {" "}
          {activeView === "editor" && tabs[activeTab] ? `${tabs[activeTab].language}${tabs[activeTab].modified ? " (modified)" : ""}` : "chat"}
        </span>
      </div>
    </div>
  );
}

export default App;
