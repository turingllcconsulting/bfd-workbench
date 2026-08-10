use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Live claude CLI processes, keyed by frontend request id, so Stop can kill them.
#[derive(Default)]
struct ClaudeProcs(Arc<Mutex<HashMap<String, u32>>>);

/// Windows: keeps a console window from flashing every time we spawn a helper.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// --- Platform plumbing -------------------------------------------------------
//
// Everything that touches a subprocess goes through here so the rest of the
// file stays OS-agnostic. Two things differ between hosts:
//
//   1. The shell. `/bin/sh -c <script>` on Unix, `cmd.exe /C <script>` on
//      Windows. Windows also needs cmd.exe specifically (not a direct spawn)
//      because the Claude CLI installs as `claude.cmd`, an npm shim that
//      CreateProcess will not resolve on its own.
//   2. PATH. A macOS/Linux GUI app inherits a minimal PATH that omits Homebrew
//      and npm prefixes, so `claude` and `git` come back "not found" even when
//      they work in Terminal — we rebuild PATH by hand. Windows GUI apps
//      inherit the full user PATH, so we leave it alone.

/// Apply the environment fixups every spawned process needs.
fn harden(cmd: &mut StdCommand) {
    #[cfg(not(windows))]
    {
        let mut path =
            String::from("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
        if let Some(home) = dirs::home_dir() {
            let h = home.to_string_lossy();
            path.push_str(&format!(":{h}/.cargo/bin:{h}/.local/bin:{h}/.bun/bin"));
            cmd.env("HOME", h.to_string());
        }
        // Keep whatever the launching environment already had (nvm, volta, asdf).
        if let Ok(existing) = std::env::var("PATH") {
            path.push(':');
            path.push_str(&existing);
        }
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// A shell invocation for the host OS.
fn shell(script: &str) -> StdCommand {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = StdCommand::new("cmd");
        c.arg("/C").arg(script);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = StdCommand::new("/bin/sh");
        c.arg("-c").arg(script);
        c
    };
    harden(&mut cmd);
    cmd
}

/// Windows-only helper for the port commands, which have no cmd.exe one-liner
/// that is worth reading.
#[cfg(windows)]
fn powershell(script: &str) -> StdCommand {
    let mut c = StdCommand::new("powershell");
    c.arg("-NoProfile").arg("-NonInteractive").arg("-Command").arg(script);
    harden(&mut c);
    c
}

fn home_dir_string() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Fallback working directory when the frontend does not pass one.
fn default_cwd(cwd: Option<String>) -> String {
    cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| {
        let home = home_dir_string();
        if home.is_empty() {
            ".".to_string()
        } else {
            home
        }
    })
}

fn safe_flag(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

/// Host facts the frontend needs to build paths correctly (it cannot assume `/`).
#[tauri::command]
fn platform_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,          // "macos" | "windows" | "linux"
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "home": home_dir_string(),
        "is_windows": cfg!(windows),
    })
}

// --- File system -------------------------------------------------------------

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dirs: {}", e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read dir {}: {}", path, e))?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    for entry in entries.flatten() {
        // A broken symlink or a permission-denied entry should skip the row,
        // not abort the whole listing.
        let Ok(metadata) = entry.metadata() else { continue };
        items.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "is_dir": metadata.is_dir(),
            "size": metadata.len(),
        }));
    }
    items.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .cmp(&b["name"].as_str().unwrap_or("").to_lowercase()),
        }
    });
    Ok(items)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create dir {}: {}", path, e))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete dir {}: {}", path, e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file {}: {}", path, e))
    }
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    let home = home_dir_string();
    if home.is_empty() {
        Err("Could not determine home directory".to_string())
    } else {
        Ok(home)
    }
}

// --- Memory ------------------------------------------------------------------

/// Walk up from `start_path` looking for `.bfd/context.md`.
#[tauri::command]
fn find_project_context(start_path: String) -> Result<String, String> {
    let mut current = PathBuf::from(&start_path);
    loop {
        let context_file = current.join(".bfd").join("context.md");
        if context_file.exists() {
            return fs::read_to_string(&context_file)
                .map_err(|e| format!("Failed to read context: {}", e));
        }
        if !current.pop() {
            return Err("No .bfd/context.md found".to_string());
        }
    }
}

/// `~/.bfd/global.md` is the canonical location. `~/BFD/.bfd/global.md` is
/// accepted as a fallback for installs that predate the move.
#[tauri::command]
fn load_global_memory() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let candidates = [
        home.join(".bfd").join("global.md"),
        home.join("BFD").join(".bfd").join("global.md"),
    ];
    for path in candidates {
        if path.exists() {
            return fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read global memory: {}", e));
        }
    }
    Ok(String::new())
}

// --- Process execution -------------------------------------------------------
//
// These are async + spawn_blocking on purpose: a synchronous Tauri command runs
// on the main thread and freezes the window for the duration of the call.

#[tauri::command]
async fn run_command(command: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    let working_dir = default_cwd(cwd);

    let output = tauri::async_runtime::spawn_blocking(move || {
        shell(&command).current_dir(&working_dir).output()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "exit_code": output.status.code().unwrap_or(-1),
    }))
}

#[tauri::command]
fn run_background(command: String, cwd: Option<String>) -> Result<String, String> {
    let working_dir = default_cwd(cwd);

    let child = shell(&command)
        .current_dir(&working_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn: {}", e))?;

    Ok(format!("Process started (PID: {})", child.id()))
}

#[tauri::command]
fn kill_port(port: u16) -> Result<String, String> {
    #[cfg(windows)]
    let result = powershell(&format!(
        "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | \
         Select-Object -ExpandProperty OwningProcess -Unique | \
         ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
    ))
    .output();
    #[cfg(not(windows))]
    let result = shell(&format!("lsof -ti:{port} | xargs kill -9 2>/dev/null; exit 0")).output();

    result.map_err(|e| format!("Failed to free port {}: {}", port, e))?;
    Ok(format!("Killed processes on port {}", port))
}

#[tauri::command]
fn check_port(port: u16) -> bool {
    #[cfg(windows)]
    let output = powershell(&format!(
        "if (Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue) \
         {{ Write-Output 'busy' }}"
    ))
    .output();
    #[cfg(not(windows))]
    let output = shell(&format!("lsof -ti:{port} 2>/dev/null")).output();

    match output {
        Ok(o) => !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        Err(_) => false,
    }
}

// --- Claude CLI bridge -------------------------------------------------------

/// Runs `claude --print --output-format stream-json` and forwards each stdout
/// line to the webview as a "claude-stream" event while the process runs.
///
/// The prompt travels over **stdin**, never through a shell string: chat history
/// routinely contains backticks and `$( )`, and an earlier version of this app
/// executed them by interpolating the prompt into `sh -c`. Only `model` and
/// `effort` reach the command line, and both are checked by `safe_flag` first.
#[tauri::command]
async fn run_claude_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClaudeProcs>,
    request_id: String,
    prompt: String,
    model: String,
    effort: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    if !safe_flag(&model) {
        return Err(format!("Invalid model id: {}", model));
    }
    if let Some(e) = &effort {
        if !safe_flag(e) {
            return Err(format!("Invalid effort level: {}", e));
        }
    }
    let working_dir = default_cwd(cwd);

    // `exec` on Unix replaces the shell so the pid we track *is* claude's.
    // Windows has no equivalent, so cmd.exe stays in the middle and Stop kills
    // the whole tree instead (see stop_claude).
    #[cfg(windows)]
    let mut cmdline = String::from("claude");
    #[cfg(not(windows))]
    let mut cmdline = String::from("exec claude");

    cmdline.push_str(&format!(
        " --model {} --print --output-format stream-json --verbose --include-partial-messages",
        model
    ));
    if let Some(e) = &effort {
        cmdline.push_str(&format!(" --effort {}", e));
    }

    let mut child = shell(&cmdline)
        .current_dir(&working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start claude: {}. Is the Claude CLI installed and on PATH? \
                 Try `npm install -g @anthropic-ai/claude-code`.",
                e
            )
        })?;

    state.0.lock().unwrap().insert(request_id.clone(), child.id());
    let procs = state.0.clone();

    let (exit_code, stderr_text) = tauri::async_runtime::spawn_blocking(move || {
        let mut stdin = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
            // stdin drops here -> EOF for the CLI
        });
        let stderr = child.stderr.take().unwrap();
        let err_reader = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buf);
            buf
        });
        let stdout = child.stdout.take().unwrap();
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let _ = app.emit(
                "claude-stream",
                serde_json::json!({ "requestId": request_id, "line": line }),
            );
        }
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = writer.join();
        let stderr_text = err_reader.join().unwrap_or_default();
        procs.lock().unwrap().remove(&request_id);
        (code, stderr_text)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    // Keep only the tail of stderr (char-boundary safe).
    let tail: String = if stderr_text.chars().count() > 2000 {
        stderr_text
            .chars()
            .skip(stderr_text.chars().count() - 2000)
            .collect()
    } else {
        stderr_text
    };

    Ok(serde_json::json!({ "exit_code": exit_code, "stderr": tail }))
}

#[tauri::command]
fn stop_claude(state: tauri::State<'_, ClaudeProcs>, request_id: String) -> Result<String, String> {
    let pid = state.0.lock().unwrap().get(&request_id).copied();
    match pid {
        Some(pid) => {
            // /T because on Windows the tracked pid is cmd.exe, and claude is
            // its child; on Unix `exec` already collapsed that indirection.
            #[cfg(windows)]
            let _ = shell(&format!("taskkill /PID {} /T /F", pid)).output();
            #[cfg(not(windows))]
            let _ = shell(&format!("kill -TERM {}", pid)).output();
            Ok(format!("Stopped request {}", request_id))
        }
        None => Err("No running request with that id".to_string()),
    }
}

// --- Git integration ---------------------------------------------------------
//
// git runs with arg vectors — nothing from the UI ever reaches a shell (same
// rule as the prompt fix above). Push/pull/fetch hit the network and can block
// for seconds, so both commands are async.

const GIT_SUBCOMMANDS: &[&str] = &[
    "status", "log", "diff", "add", "commit", "push", "pull", "fetch", "init", "branch", "checkout",
    "switch", "remote", "rev-parse", "rev-list", "show", "stash", "ls-files", "restore", "merge",
];

fn git_output(repo: &str, args: &[String]) -> Result<(String, String, i32), String> {
    let mut cmd = StdCommand::new("git");
    cmd.arg("-C").arg(repo).args(args);
    harden(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}. Is git installed and on PATH?", e))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

#[tauri::command]
async fn git_run(repo: String, args: Vec<String>) -> Result<serde_json::Value, String> {
    let sub = args.first().cloned().unwrap_or_default();
    if !GIT_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!("git subcommand not allowed: {}", sub));
    }
    let (stdout, stderr, code) =
        tauri::async_runtime::spawn_blocking(move || git_output(&repo, &args))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;
    Ok(serde_json::json!({ "stdout": stdout, "stderr": stderr, "exit_code": code }))
}

/// One-call summary for the sidebar panel: branch, dirty count (tracked files
/// only — untracked scans are too slow in a home directory), last commit,
/// remote, ahead/behind.
#[tauri::command]
async fn git_overview(repo: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (top, _, code) = git_output(&repo, &["rev-parse".into(), "--show-toplevel".into()])?;
        if code != 0 {
            return Ok(serde_json::json!({ "is_repo": false }));
        }
        let root = top.trim().to_string();
        let (branch, _, _) = git_output(&root, &["branch".into(), "--show-current".into()])?;
        let (status, _, _) =
            git_output(&root, &["status".into(), "--porcelain".into(), "-uno".into()])?;
        let changed = status.lines().filter(|l| !l.trim().is_empty()).count();
        let (last, _, _) = git_output(&root, &["log".into(), "-1".into(), "--format=%h %s".into()])?;
        let (remote, _, rcode) =
            git_output(&root, &["remote".into(), "get-url".into(), "origin".into()])?;
        let (counts, _, ccode) = git_output(
            &root,
            &[
                "rev-list".into(),
                "--left-right".into(),
                "--count".into(),
                "@{u}...HEAD".into(),
            ],
        )?;
        let (behind, ahead) = if ccode == 0 {
            let mut it = counts.split_whitespace();
            (
                it.next().unwrap_or("0").parse::<i64>().unwrap_or(0),
                it.next().unwrap_or("0").parse::<i64>().unwrap_or(0),
            )
        } else {
            (0, 0)
        };
        Ok(serde_json::json!({
            "is_repo": true,
            "root": root,
            "branch": branch.trim(),
            "changed": changed,
            "last_commit": last.trim(),
            "remote": if rcode == 0 { serde_json::Value::String(remote.trim().to_string()) } else { serde_json::Value::Null },
            "ahead": ahead,
            "behind": behind,
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ClaudeProcs::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            platform_info,
            read_file,
            write_file,
            list_dir,
            file_exists,
            create_dir,
            delete_file,
            get_home_dir,
            find_project_context,
            load_global_memory,
            run_command,
            run_claude_stream,
            stop_claude,
            run_background,
            kill_port,
            check_port,
            git_run,
            git_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
