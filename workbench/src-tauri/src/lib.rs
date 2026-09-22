use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Live claude CLI processes, keyed by frontend request id, so Stop can kill them.
#[derive(Default)]
struct ClaudeProcs(Arc<Mutex<HashMap<String, u32>>>);

fn safe_flag(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

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
    for entry in entries {
        if let Ok(entry) = entry {
            let metadata = entry.metadata().unwrap();
            items.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": entry.path().to_string_lossy(),
                "is_dir": metadata.is_dir(),
                "size": metadata.len(),
            }));
        }
    }
    items.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"].as_str().unwrap_or("").to_lowercase()
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
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

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

#[tauri::command]
fn load_global_memory() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let global_path = home.join("BFD").join(".bfd").join("global.md");
    if global_path.exists() {
        fs::read_to_string(&global_path)
            .map_err(|e| format!("Failed to read global memory: {}", e))
    } else {
        Ok(String::new())
    }
}

// Async + spawn_blocking: a sync command runs on the main thread and freezes
// the UI (beachball) for the duration of long calls like the Claude CLI.
#[tauri::command]
async fn run_command(command: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    let working_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/tmp".to_string())
    });

    let output = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new("/bin/sh")
            .arg("-c")
            .arg(&command)
            .current_dir(&working_dir)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
            .env("HOME", dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
            .output()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": output.status.code().unwrap_or(-1),
    }))
}


#[tauri::command]
fn run_background(command: String, cwd: Option<String>) -> Result<String, String> {
    let working_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/tmp".to_string())
    });
    
    let child = StdCommand::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&working_dir)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .env("HOME", dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn: {}", e))?;
    
    Ok(format!("Process started (PID: {})", child.id()))
}

#[tauri::command]
fn kill_port(port: u16) -> Result<String, String> {
    let output = StdCommand::new("/bin/sh")
        .arg("-c")
        .arg(format!("lsof -ti:{} | xargs kill -9 2>/dev/null; echo done", port))
        .output()
        .map_err(|e| format!("Failed: {}", e))?;
    Ok(format!("Killed processes on port {}", port))
}

#[tauri::command]
fn check_port(port: u16) -> bool {
    let output = StdCommand::new("/bin/sh")
        .arg("-c")
        .arg(format!("lsof -ti:{} 2>/dev/null", port))
        .output();
    match output {
        Ok(o) => !o.stdout.is_empty(),
        Err(_) => false,
    }
}
// Runs `claude --print --output-format stream-json` and forwards each stdout
// line to the webview as a "claude-stream" event while the process runs.
// The prompt travels over stdin — never through a shell string, because chat
// history containing backticks/$( ) must not be executable by /bin/sh.
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
    let working_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/tmp".to_string())
    });

    let mut cmdline = format!(
        "exec claude --model {} --print --output-format stream-json --verbose --include-partial-messages",
        model
    );
    if let Some(e) = &effort {
        cmdline.push_str(&format!(" --effort {}", e));
    }

    let mut child = StdCommand::new("/bin/sh")
        .arg("-c")
        .arg(&cmdline)
        .current_dir(&working_dir)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .env("HOME", dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start claude: {}", e))?;

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
        stderr_text.chars().skip(stderr_text.chars().count() - 2000).collect()
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
            let _ = StdCommand::new("/bin/kill").arg("-TERM").arg(pid.to_string()).output();
            Ok(format!("Stopped request {}", request_id))
        }
        None => Err("No running request with that id".to_string()),
    }
}

// --- Git integration (v0.11.0) ---
// git runs with arg vectors — nothing from the UI ever reaches /bin/sh (same
// rule as the 0.9.0 prompt fix). Push/pull/fetch hit the network and can block
// for seconds, so both commands are async (the 0.8.0 beachball lesson).

const GIT_SUBCOMMANDS: &[&str] = &[
    "status", "log", "diff", "add", "commit", "push", "pull", "fetch", "init",
    "branch", "checkout", "switch", "remote", "rev-parse", "rev-list", "show",
    "stash", "ls-files", "restore", "merge",
];

fn git_output(repo: &str, args: &[String]) -> Result<(String, String, i32), String> {
    let out = StdCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .env("HOME", dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
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

// One-call summary for the sidebar panel: branch, dirty count (tracked files
// only — untracked scans are too slow in $HOME), last commit, remote, ahead/behind.
#[tauri::command]
async fn git_overview(repo: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (top, _, code) = git_output(&repo, &["rev-parse".into(), "--show-toplevel".into()])?;
        if code != 0 {
            return Ok(serde_json::json!({ "is_repo": false }));
        }
        let root = top.trim().to_string();
        let (branch, _, _) = git_output(&root, &["branch".into(), "--show-current".into()])?;
        let (status, _, _) = git_output(&root, &["status".into(), "--porcelain".into(), "-uno".into()])?;
        let changed = status.lines().filter(|l| !l.trim().is_empty()).count();
        let (last, _, _) = git_output(&root, &["log".into(), "-1".into(), "--format=%h %s".into()])?;
        let (remote, _, rcode) = git_output(&root, &["remote".into(), "get-url".into(), "origin".into()])?;
        let (counts, _, ccode) = git_output(&root, &[
            "rev-list".into(), "--left-right".into(), "--count".into(), "@{u}...HEAD".into(),
        ])?;
        let (behind, ahead) = if ccode == 0 {
            let mut it = counts.trim().split_whitespace();
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
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
