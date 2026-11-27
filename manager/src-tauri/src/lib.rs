mod runtime;
mod fonts;
mod update;

use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Absolute project root (the Rust crate lives in <root>/manager/src-tauri).
/// Only the CLI is required here: the interpreter may be the machine-wide
/// Python instead of a bundled runtime.
fn has_runtime_layout(root: &PathBuf) -> bool {
    root.join("core").join("cli.py").is_file()
        || root.join("resources").join("core").join("cli.py").is_file()
}

fn project_root() -> PathBuf {
    // Do not assume the process current directory. A desktop app can be
    // launched from a shortcut, the Start menu, or a different shell folder.
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(exe.ancestors().map(PathBuf::from));
    }
    if let Ok(dir) = std::env::current_dir() {
        candidates.extend(dir.ancestors().map(PathBuf::from));
    }
    candidates.into_iter().find(has_runtime_layout)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn bundled_python(root: &PathBuf) -> Option<PathBuf> {
    [
        root.join("runtime").join("python").join("python.exe"),
        root.join("resources").join("runtime").join("python").join("python.exe"),
        root.join(".venv").join("Scripts").join("python.exe"),
    ].into_iter().find(|path| path.is_file())
}

/// Resolve an interpreter through the `py` launcher or `python` on PATH and
/// keep the path it reports, so callers always get a real executable even
/// when those names are shims (e.g. the Microsoft Store alias).
fn probe_python(program: &str, version_flag: Option<&str>) -> Option<PathBuf> {
    let mut cmd = silent_command(program);
    if let Some(flag) = version_flag {
        cmd.arg(flag);
    }
    let output = cmd
        .args(["-c", "import sys;print(sys.executable)"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

/// Interpreters known to the `py` launcher, newest first. Parsing its listing
/// finds installs that are absent from this process's PATH, which happens when
/// Python is installed after the GUI inherited its environment.
fn launcher_paths(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| {
            // " -V:3.14[-64] *   C:\Program Files\Python314\python.exe"
            let tail = line
                .rsplit(']')
                .next()
                .unwrap_or(line)
                .trim_start_matches(|c: char| c == '*' || c.is_whitespace());
            if tail.to_ascii_lowercase().ends_with("python.exe") {
                Some(PathBuf::from(tail))
            } else {
                None
            }
        })
        .collect()
}

/// `HKEY_*\SOFTWARE\Python\PythonCore\<version>\InstallPath` records every
/// python.org install. Reading it covers interpreters installed without the
/// launcher or without a PATH entry.
fn registry_paths(text: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut in_install_path = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("HKEY_") {
            in_install_path = line.ends_with("\\InstallPath");
            continue;
        }
        if !in_install_path {
            continue;
        }
        let Some((name, value)) = line.split_once("REG_SZ") else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let name = name.trim();
        if name.eq_ignore_ascii_case("ExecutablePath") {
            paths.push(PathBuf::from(value));
        } else if name == "(Default)" {
            paths.push(PathBuf::from(value).join("python.exe"));
        }
    }
    paths
}

fn is_windows_store_stub(path: &std::path::Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("\\microsoft\\windowsapps\\")
}

fn where_pythons() -> Vec<PathBuf> {
    let Ok(output) = silent_command("where").arg("python").output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file() && !is_windows_store_stub(path))
        .collect()
}

/// Standard installer locations, newest first, as the last resort for machines
/// that have neither the launcher nor registry entries available.
fn installed_python_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut direct_candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local_path = PathBuf::from(&local);
        roots.push(local_path.join("Programs").join("Python"));
        roots.push(local_path.join("Python"));
        for conda in ["miniconda3", "anaconda3", "Miniconda3", "Anaconda3"] {
            direct_candidates.push(local_path.join(conda).join("python.exe"));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile_path = PathBuf::from(&profile);
        for conda in ["miniconda3", "anaconda3", "Miniconda3", "Anaconda3", "mambaforge", "miniforge3"] {
            direct_candidates.push(profile_path.join(conda).join("python.exe"));
        }
        roots.push(profile_path.join(".pyenv").join("pyenv-win").join("versions"));
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Ok(base) = std::env::var(variable) {
            let base_path = PathBuf::from(base);
            roots.push(base_path.clone());
            for conda in ["miniconda3", "anaconda3", "Miniconda3", "Anaconda3"] {
                direct_candidates.push(base_path.join(conda).join("python.exe"));
            }
        }
    }
    roots.push(PathBuf::from("C:\\"));
    let mut found = Vec::new();
    for executable in direct_candidates {
        if executable.is_file() {
            found.push(executable);
        }
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let is_pyenv_ver = root.to_string_lossy().to_ascii_lowercase().ends_with("pyenv-win\\versions")
                && name.starts_with('3');
            if !(name.starts_with("python3") || name.starts_with("pythoncore-3") || is_pyenv_ver) {
                continue;
            }
            let executable = entry.path().join("python.exe");
            if executable.is_file() {
                found.push(executable);
            }
        }
    }
    found.sort_by_key(|path| {
        std::cmp::Reverse(std::fs::metadata(path).and_then(|data| data.modified()).ok())
    });
    found
}

/// Collect all unique, real Python executables available on this machine,
/// putting `python` on PATH first so a machine that responds to `python` in
/// the terminal is reused directly.
fn system_pythons() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |path: PathBuf| {
        if !path.is_file() || is_windows_store_stub(&path) {
            return;
        }
        let key = path.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            candidates.push(path);
        }
    };
    for found in [
        probe_python("python", None),
        probe_python("py", Some("-3")),
        probe_python("python3", None),
        probe_python("py", None),
    ]
    .into_iter()
    .flatten()
    {
        push(found);
    }
    for found in where_pythons() {
        push(found);
    }
    if let Ok(output) = silent_command("py").arg("-0p").output() {
        if output.status.success() {
            for found in launcher_paths(&String::from_utf8_lossy(&output.stdout)) {
                push(found);
            }
        }
    }
    for hive in ["HKCU", "HKLM"] {
        for key in [
            "SOFTWARE\\Python\\PythonCore",
            "SOFTWARE\\WOW6432Node\\Python\\PythonCore",
        ] {
            if let Ok(output) = silent_command("reg")
                .args(["query", &format!("{hive}\\{key}"), "/s"])
                .output()
            {
                if output.status.success() {
                    for found in registry_paths(&String::from_utf8_lossy(&output.stdout)) {
                        push(found);
                    }
                }
            }
        }
    }
    for found in installed_python_dirs() {
        push(found);
    }
    candidates
}

/// Choose the best existing local Python on this machine: prefer one that
/// already has all runtime dependencies installed; otherwise fall back to the
/// first working Python 3 interpreter.
pub(crate) fn best_local_python(root: &std::path::Path) -> Option<PathBuf> {
    let code = code_root(&root.to_path_buf());
    let candidates = system_pythons();
    if candidates.is_empty() {
        return None;
    }
    let mut first_valid: Option<PathBuf> = None;
    for candidate in candidates.iter().take(6) {
        if let Ok((major, minor, _)) = runtime::python_minor_version(candidate) {
            if major == 3 && minor >= 10 {
                if first_valid.is_none() {
                    first_valid = Some(candidate.clone());
                }
                if runtime::missing_dependencies(candidate, &code, Duration::from_secs(6)).is_ok() {
                    return Some(candidate.clone());
                }
            }
        }
    }
    first_valid.or_else(|| candidates.into_iter().next())
}

/// Printed in the environment check so a detected interpreter is visible even
/// when its dependencies are missing.
fn python_version(python: &PathBuf) -> Option<String> {
    let output = silent_command(python)
        .args(["-c", "import sys;print(sys.version.split()[0])"])
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    })
}

static PYTHON_CACHE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

pub(crate) fn reset_python_cache() {
    if let Ok(mut guard) = PYTHON_CACHE.lock() {
        *guard = None;
    }
}

/// Prefer a user-selected / local-reused venv or bundled runtime; otherwise
/// detect the best machine-wide Python. Cached between polls and cleared on
/// explicit re-check or setup.
fn python_path(root: &PathBuf) -> PathBuf {
    if let Some(path) = runtime::selected_python(root)
        .or_else(|| bundled_python(root))
        .or_else(|| runtime::prepared_python(root))
    {
        return path;
    }
    if let Ok(guard) = PYTHON_CACHE.lock() {
        if let Some(path) = guard.as_ref() {
            if path.is_file() {
                return path.clone();
            }
        }
    }
    let resolved = best_local_python(root).unwrap_or_else(|| PathBuf::from("python"));
    // Do not cache the bare fallback, so installing Python later is picked up
    // by the environment check without restarting the GUI.
    if resolved.is_file() {
        if let Ok(mut guard) = PYTHON_CACHE.lock() {
            *guard = Some(resolved.clone());
        }
    }
    resolved
}

fn cli_path(root: &PathBuf) -> PathBuf {
    let bundled = root.join("resources").join("core").join("cli.py");
    if bundled.is_file() { bundled } else { root.join("core").join("cli.py") }
}

/// Run a probe process with a hard timeout and capture stdout/stderr so
/// callers can report exact errors without hanging the UI.
pub(crate) fn run_output_with_timeout(
    program: &std::path::Path,
    args: &[&str],
    cwd: &std::path::Path,
    timeout: std::time::Duration,
) -> Option<(bool, String, String)> {
    let mut child = silent_command(program)
        .args(args)
        .current_dir(cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout_pipe = child.stdout.take()?;
    let mut stderr_pipe = child.stderr.take()?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buffer);
        buffer
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let stdout = String::from_utf8_lossy(&stdout_reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default()).into_owned();
    Some((status.success(), stdout, stderr))
}

/// Run a probe process with a hard timeout so a hanging interpreter can never
/// stall the UI. Returns `None` on spawn failure or timeout.
fn run_with_timeout(
    program: &PathBuf,
    args: &[&str],
    cwd: &PathBuf,
    timeout: std::time::Duration,
) -> Option<bool> {
    run_output_with_timeout(program, args, cwd, timeout).map(|(ok, _, _)| ok)
}

fn find_camoufox_exe(dir: &PathBuf, depth: usize) -> Option<PathBuf> {
    let exe = dir.join("camoufox.exe");
    if exe.is_file() {
        return Some(exe);
    }
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            if let Some(found) = find_camoufox_exe(&entry.path(), depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

/// Locate an installed engine on disk. Never ask camoufox for its path:
/// `pkgman.get_path` resolves the build and may hit the network.
fn find_engine(root: &PathBuf) -> Option<PathBuf> {
    let mut dirs = vec![
        root.join("runtime").join("camoufox"),
        root.join("resources").join("runtime").join("camoufox"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("camoufox"));
    }
    if let Ok(custom) = std::env::var("CAMOUFOX_INSTALL_DIR") {
        dirs.push(PathBuf::from(custom));
    }
    dirs.into_iter().find_map(|dir| find_camoufox_exe(&dir, 6))
}

fn code_root(root: &PathBuf) -> PathBuf {
    cli_path(root).parent().and_then(|p| p.parent())
        .map(PathBuf::from).unwrap_or_else(|| root.clone())
}

/// User-owned data lives in one portable `data` folder so the whole
/// directory can be copied to migrate to another machine. Development runs
/// keep it under the repo; packaged builds use LocalAppData.
fn storage_root(root: &PathBuf) -> PathBuf {
    let base = if has_runtime_layout(root) && root.join("core").join("cli.py").is_file() {
        root.clone()
    } else if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data).join("ShadowFox")
    } else {
        root.clone()
    };
    let data = base.join("data");
    let _ = std::fs::create_dir_all(&data);
    data
}

fn packs_dir(root: &PathBuf) -> PathBuf {
    let dir = storage_root(root).join("packs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// A Command that never opens a console window on Windows. Without this,
/// every python/reg subprocess flashes a black box over the GUI.
fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A hung CLI must not pin a blocking-pool thread forever: async commands make
/// repeated operations pile up otherwise. Budgets are per command family.
fn cli_timeout(args: &[&str]) -> Duration {
    match args.first().copied().unwrap_or("") {
        "list" | "status" | "history" | "proxy-sources" | "proxy-nodes"
        | "proxy-discover" | "ext-list" => Duration::from_secs(30),
        "launch" | "stop" | "cookies" => Duration::from_secs(120),
        "create" | "clone" | "rebuild" | "ext-install" | "ext-import"
        | "proxy-import" => Duration::from_secs(300),
        "export" | "export-all" | "import" | "import-all" => Duration::from_secs(900),
        _ => Duration::from_secs(180),
    }
}

fn run_cli(args: &[&str]) -> Result<Value, String> {
    let root = project_root();
    let python = python_path(&root);
    if !python.is_file() {
        return Err("未找到可用的 Python 运行时，请安装 Python 或创建项目 .venv".into());
    }
    let code = code_root(&root);
    let data_root = storage_root(&root);
    let profiles = data_root.join("profiles");
    let mut child = silent_command(&python)
        .arg(code.join("core/bootstrap.py"))
        .arg("--profiles")
        .arg(&profiles)
        .args(args)
        .current_dir(&code)
        .env("PYTHONPATH", &code)
        .env("PYTHONIOENCODING", "utf-8")
        .envs(runtime::prepared_engine(&root).map(|path| ("CACER_ENGINE_DIR", path)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run CLI: {e}"))?;

    // Drain both pipes on their own threads; a full pipe buffer would deadlock
    // a plain wait loop once a list gets long.
    let mut stdout_pipe = child.stdout.take().ok_or("无法读取命令输出")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法读取命令输出")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buffer);
        buffer
    });

    let timeout = cli_timeout(args);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "命令执行超时（{} 秒），请检查网络或代理配置",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("failed to wait for CLI: {e}"));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&stdout_reader.join().unwrap_or_default())
        .trim()
        .to_string();
    let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default())
        .trim()
        .to_string();
    if !status.success() {
        let detail = format!("{}{}", stdout, stderr).trim().to_string();
        let message = if detail.contains("could not draw a coherent identity") {
            "暂时没有生成符合条件的指纹，请稍后重试".to_string()
        } else if detail.contains("proxy mode requires") {
            "代理模式需要选择节点或填写代理服务器".to_string()
        } else if detail.contains("unsupported os") || detail.contains("unsupported country") {
            format!("身份参数不受支持：{detail}")
        } else {
            detail
        };
        let label = match args.first() {
            Some(&"create") => "创建命令失败",
            Some(&"edit") => "保存失败",
            Some(&"proxy-import") => "导入订阅失败",
            Some(&"proxy-delete") => "删除订阅失败",
            Some(&"proxy-set-core") => "设置内核失败",
            Some(&"import") => "导入身份包失败",
            Some(&"launch") => "启动失败",
            _ => "命令执行失败",
        };
        return Err(format!("{label}：{message}"));
    }
    if stdout.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&stdout).map_err(|e| format!("bad CLI JSON {e}: {stdout}"))
}

/// Run the CLI off the async worker so URL downloads cannot stall the UI.
async fn run_cli_task(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|arg| arg.as_str()).collect();
        run_cli(&refs)
    })
    .await
    .map_err(|e| format!("命令执行失败：{e}"))?
}

#[tauri::command]
async fn list_identities() -> Result<Value, String> {
    run_cli_task(vec!["list".into()]).await
}

/// Return actionable diagnostics for the first-run screen and support logs.
/// This deliberately does not launch anything; it only checks the local
/// runtime required by the current development distribution.
#[tauri::command]
async fn environment_check() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(environment_check_sync).await.map_err(|e| e.to_string())?
}

fn environment_check_sync() -> Result<Value, String> {
    reset_python_cache();
    let root = project_root();
    let data_root = storage_root(&root);
    let python = python_path(&root);
    let cli = cli_path(&root);
    let profiles = data_root.join("profiles");
    let python_ok = python.is_file();
    let detected_version = python_ok.then(|| python_version(&python)).flatten();
    let cli_ok = cli.is_file();
    let profiles_ok = profiles.is_dir() || std::fs::create_dir_all(&profiles).is_ok();
    let camoufox_exe = find_engine(&root);
    let engine_ok = camoufox_exe.is_some();
    // Probe the import with a timeout: a slow interpreter must not freeze the UI.
    let missing_deps = if python_ok {
        runtime::missing_dependencies(&python, &code_root(&root), std::time::Duration::from_secs(10)).err()
    } else {
        None
    };
    let camoufox_import_ok = python_ok && missing_deps.is_none();
    let checks = vec![
        serde_json::json!({
            "key": "python",
            "label": "Python 解释器",
            "ok": python_ok,
            "detail": if python_ok {
                match &detected_version {
                    Some(version) => format!("Python {version} · {}", python.display()),
                    None => python.display().to_string(),
                }
            } else {
                "未自动检测到本机 Python。如果本机已安装，请点「选择本地目录」指定 Python 路径；否则可按手动安装说明安装".to_string()
            }
        }),
        serde_json::json!({
            "key": "dependencies",
            "label": "Python 依赖包",
            "ok": camoufox_import_ok,
            "detail": if camoufox_import_ok {
                "该 Python 已安装 camoufox、playwright、fpgen、Pillow、PySocks".to_string()
            } else if python_ok {
                let missing_hint = missing_deps.as_deref().map(|m| format!("（缺少：{m}）")).unwrap_or_default();
                format!("已检测到本机 Python，但缺少运行依赖{missing_hint}。点「一键安装依赖」将复用此 Python 创建独立环境并安装依赖，无需下载完整 Python 包")
            } else {
                "请先选择本机 Python 目录，或手动安装 Python".to_string()
            }
        }),
        serde_json::json!({
            "key": "cli",
            "label": "Cacer CLI",
            "ok": cli_ok,
            "detail": cli.display().to_string()
        }),
        serde_json::json!({
            "key": "profiles",
            "label": "身份数据目录",
            "ok": profiles_ok,
            "detail": profiles.display().to_string()
        }),
        serde_json::json!({
            "key": "engine",
            "label": "Camoufox 浏览器引擎",
            "ok": engine_ok,
            "detail": if let Some(exe) = &camoufox_exe {
                exe.display().to_string()
            } else {
                "浏览器核心缺失，请重新安装当前版本".to_string()
            }
        }),
    ];
    let manifest = runtime::manifest(&root).ok();
    Ok(serde_json::json!({
        "ready": python_ok && cli_ok && profiles_ok && engine_ok && camoufox_import_ok,
        "root": root.display().to_string(),
        "data_root": data_root.display().to_string(),
        "python_detected": python_ok,
        "python_path": python_ok.then(|| python.display().to_string()),
        "python_version": detected_version,
        "dependencies_ready": camoufox_import_ok,
        "fonts_ready": fonts::overview(&root, &serde_json::json!({}))?["ready"],
        "python_size": manifest.as_ref().map(|m| m.python.size),
        "fonts_size": manifest.as_ref().map(|m| m.fonts.as_ref().map(|a| a.size)
            .unwrap_or_else(|| m.font_packs.iter().map(|p| p.asset.size).sum())),
        "manual_commands": runtime::guide(&root).unwrap_or_else(|_| "开发环境：python -m pip install -r requirements-runtime.txt".into()),
        "checks": checks
    }))
}

#[tauri::command]
fn runtime_status() -> runtime::Status { runtime::status() }

#[tauri::command]
fn cancel_runtime() { runtime::cancel(); }

#[tauri::command]
async fn install_runtime(kind: String, proxy: String, font_ids: Option<Vec<String>>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime::operation(|| {
            let root = project_root();
            let path = if kind == "fonts" {
                fonts::install(&root, &font_ids.unwrap_or_default(), &proxy)?
            } else { runtime::install(&root, &kind, &proxy)? };
            if kind == "python" {
                runtime::select_python(&root, &path.join("python.exe").to_string_lossy())?;
            }
            Ok(serde_json::json!({ "path": path }))
        })
    }).await.map_err(|e| e.to_string())?
}

fn font_overview_sync(identity_id: Option<&str>, country: Option<&str>) -> Result<Value, String> {
    let root = project_root();
    if runtime::manifest(&root).is_err() { return fonts::overview(&root, &Value::Null); }
    let request = if let Some(id) = identity_id {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("无效环境 ID".into());
        }
        run_cli(&["font-requirements", id])?
    } else {
        serde_json::json!({"country": country, "ui_locale": if country.is_some() { "zh-CN" } else { "" }})
    };
    fonts::overview(&root, &request)
}
#[tauri::command]
async fn font_overview(identity_id: Option<String>, country: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move ||
        font_overview_sync(identity_id.as_deref(), country.as_deref())
    ).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn download_settings() -> runtime::DownloadSettings { runtime::download_settings(&project_root()) }

#[tauri::command]
fn save_download_settings(settings: runtime::DownloadSettings) -> Result<(), String> {
    runtime::save_download_settings(&project_root(), &settings)
}

#[tauri::command]
async fn select_python(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime::operation(|| {
            runtime::select_python(&project_root(), &path)?;
            environment_check_sync()
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn setup_local_python(path: Option<String>, proxy: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime::operation(|| {
            let root = project_root();
            let executable = runtime::setup_local_python(&root, path.as_deref(), &proxy)?;
            Ok(serde_json::json!({
                "path": executable,
                "environment": environment_check_sync()?,
            }))
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_python_path(kind: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || runtime::pick_python_location(&kind))
        .await
        .map_err(|e| e.to_string())?
}

fn default_dialog_dir(preset: Option<&str>) -> Option<String> {
    match preset {
        Some("downloads") => std::env::var("USERPROFILE")
            .ok()
            .map(|home| PathBuf::from(home).join("Downloads"))
            .filter(|dir| dir.is_dir())
            .map(|dir| dir.to_string_lossy().into_owned()),
        Some("packs") => Some(packs_dir(&project_root()).to_string_lossy().into_owned()),
        Some("data") => Some(storage_root(&project_root()).to_string_lossy().into_owned()),
        Some(other) if !other.trim().is_empty() => Some(other.trim().to_string()),
        _ => None,
    }
}

#[tauri::command]
async fn pick_dialog(
    kind: String,
    title: Option<String>,
    filter: Option<String>,
    default_name: Option<String>,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_dir = default_dialog_dir(default_dir.as_deref());
        runtime::pick_dialog(
            &kind,
            title.as_deref(),
            filter.as_deref(),
            default_name.as_deref(),
            resolved_dir.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    let target = PathBuf::from(trimmed);
    if target.is_file() {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| format!("无法打开所在文件夹：{e}"))?;
        return Ok(());
    }
    let dir = if target.is_dir() {
        target
    } else if let Some(parent) = target.parent().filter(|p| p.is_dir()) {
        parent.to_path_buf()
    } else {
        return Err(format!("路径不存在：{}", target.display()));
    };
    Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("无法打开文件夹：{e}"))?;
    Ok(())
}

#[tauri::command]
async fn create_identity(req: Value) -> Result<Value, String> {
    let name = req["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("名称必填".into());
    }
    let os = req["os"].as_str().unwrap_or("");
    let country = req["country"].as_str().unwrap_or("");
    let network = req["network"].as_str().unwrap_or("direct");
    let proxy_server = req["proxy_server"].as_str().unwrap_or("");
    let proxy_source = req["proxy_source"].as_str().unwrap_or("");
    let proxy_node = req["proxy_node"].as_str().unwrap_or("");
    let note = req["note"].as_str().unwrap_or("");
    let ui_locale = req["ui_locale"].as_str().unwrap_or("zh-CN");
    let memory_cache = req["memory_cache"].as_bool().unwrap_or(true);

    // Country-filtered fingerprint draws can legitimately miss several times;
    // use a larger budget for GUI creation so users do not see intermittent
    // `CLI rc=1` failures.
    let mut args: Vec<String> = vec![
        "create".into(),
        name.clone(),
        "--network".into(),
        network.to_string(),
        "--max-draws".into(),
        "80".into(),
    ];
    if !os.is_empty() {
        args.push("--os".into());
        args.push(os.to_string());
    }
    if !country.is_empty() {
        args.push("--country".into());
        args.push(country.to_string());
    }
    if !proxy_server.is_empty() {
        args.push("--proxy-server".into());
        args.push(proxy_server.to_string());
    }
    if !proxy_source.is_empty() && !proxy_node.is_empty() {
        args.push("--proxy-source".into());
        args.push(proxy_source.to_string());
        args.push("--proxy-node".into());
        args.push(proxy_node.to_string());
    }
    if !note.is_empty() {
        args.push("--note".into());
        args.push(note.to_string());
    }
    args.push("--ui-locale".into());
    args.push(ui_locale.to_string());
    if !memory_cache {
        args.push("--no-memory-cache".into());
    }
    run_cli_task(args).await
}

#[tauri::command]
fn system_proxy() -> Result<Value, String> {
    // Read the Windows user proxy (WinINET) so the GUI can prefill
    // "use system proxy" for new identities.
    let out = silent_command("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .map_err(|e| format!("reg query failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let server = text
        .lines()
        .find(|l| l.contains("ProxyServer"))
        .and_then(|l| l.rsplit(|c: char| c.is_whitespace()).next())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let out2 = silent_command("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()
        .map_err(|e| format!("reg query failed: {e}"))?;
    let text2 = String::from_utf8_lossy(&out2.stdout);
    let enabled = text2.contains("0x1");
    Ok(serde_json::json!({ "enabled": enabled, "server": server }))
}

#[tauri::command]
async fn edit_identity(id: String, req: Value) -> Result<Value, String> {
    let name = req["name"].as_str().unwrap_or("");
    let note = req["note"].as_str();
    let network = req["network"].as_str().unwrap_or("");
    let proxy_server = req["proxy_server"].as_str();
    let proxy_source = req["proxy_source"].as_str();
    let proxy_node = req["proxy_node"].as_str();
    let clear_proxy = req["clear_proxy"].as_bool().unwrap_or(false);
    let ui_locale = req["ui_locale"].as_str();
    let memory_cache = req["memory_cache"].as_bool();

    let mut args: Vec<String> = vec!["edit".into(), id.clone()];
    if !name.is_empty() {
        args.push("--name".into());
        args.push(name.to_string());
    }
    // Always forward the note (possibly empty) so it can be cleared.
    if let Some(value) = note {
        args.push("--note".into());
        args.push(value.to_string());
    }
    if !network.is_empty() {
        args.push("--network".into());
        args.push(network.to_string());
    }
    if let Some(locale) = ui_locale {
        args.push("--ui-locale".into());
        args.push(locale.to_string());
    }
    if let Some(cache) = memory_cache {
        args.push(if cache { "--memory-cache".to_string() } else { "--no-memory-cache".to_string() });
    }
    // Empty strings explicitly clear a previous subscription selection.
    if let Some(source) = proxy_source {
        args.push("--proxy-source".into());
        args.push(source.to_string());
    }
    if let Some(node) = proxy_node {
        args.push("--proxy-node".into());
        args.push(node.to_string());
    }
    if clear_proxy {
        args.push("--clear-proxy".into());
    } else if let Some(server) = proxy_server {
        // Only touch routing when the frontend actually sent the field: edits
        // made while the browser is running carry name/note only.
        args.push("--proxy-server".into());
        args.push(server.to_string());
    }
    run_cli_task(args).await
}

#[tauri::command]
async fn reorder_identities(ids: Vec<String>) -> Result<Value, String> {
    if ids.is_empty() {
        return Err("排序列表不能为空".into());
    }
    run_cli_task(vec!["reorder".into(), "--ids".into(), ids.join(",")]).await
}

#[tauri::command]
async fn export_cookies(id: String, output: String) -> Result<Value, String> {
    if output.trim().is_empty() { return Err("导出路径不能为空".into()); }
    run_cli_task(vec![
        "cookies".into(),
        id,
        "--output".into(),
        output.trim().to_string(),
    ])
    .await
}

#[tauri::command]
async fn rebuild_identity(id: String, os: String, country: String) -> Result<Value, String> {
    let mut args: Vec<String> =
        vec!["rebuild".into(), id, "--max-draws".into(), "80".into()];
    if !os.is_empty() {
        args.push("--os".into());
        args.push(os);
    }
    if !country.is_empty() {
        args.push("--country".into());
        args.push(country);
    }
    run_cli_task(args).await
}

#[tauri::command]
async fn clone_identity(id: String, name: String) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("新环境名称不能为空".into());
    }
    run_cli_task(vec!["clone".into(), id, name.to_string()]).await
}

#[tauri::command]
async fn delete_identity(id: String, purge: bool) -> Result<Value, String> {
    if purge {
        run_cli_task(vec!["delete".into(), id, "--purge-profile".into()]).await
    } else {
        run_cli_task(vec!["delete".into(), id]).await
    }
}

#[tauri::command]
async fn launch_identity(id: String) -> Result<Value, String> {
    let check_id = id.clone();
    let plan = tauri::async_runtime::spawn_blocking(move ||
        font_overview_sync(Some(&check_id), None)
    ).await.map_err(|e| e.to_string())??;
    if plan["ready"] != true {
        return Err("该环境需要的字体尚未下载，请在字体库中准备后再启动".into());
    }
    // The Python CLI supervises the detached browser helper. Returning after
    // the helper publishes `starting` keeps the Tauri UI responsive; the
    // frontend refresh loop observes the later `running` state.
    run_cli_task(vec!["launch".into(), id, "--no-wait".into()]).await
}

#[tauri::command]
async fn stop_identity(id: String) -> Result<Value, String> {
    run_cli_task(vec!["stop".into(), id]).await
}

// ------------------------------------------------------- proxy subscriptions

#[tauri::command]
async fn proxy_sources() -> Result<Value, String> {
    run_cli_task(vec!["proxy-sources".into()]).await
}

#[tauri::command]
async fn proxy_nodes(source: String) -> Result<Value, String> {
    if source.trim().is_empty() {
        return Err("请先选择订阅".into());
    }
    run_cli_task(vec![
        "proxy-nodes".into(),
        "--source".into(),
        source.trim().to_string(),
    ])
    .await
}

/// Async: subscription URLs are fetched over the network.
#[tauri::command]
async fn proxy_import(kind: String, value: String, name: String, label: String) -> Result<Value, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("订阅内容不能为空".into());
    }
    let mut args: Vec<String> = vec![
        "proxy-import".into(),
        "--kind".into(),
        kind,
        "--value".into(),
        value.to_string(),
    ];
    if !name.trim().is_empty() {
        args.push("--name".into());
        args.push(name.trim().to_string());
    }
    if !label.trim().is_empty() {
        args.push("--label".into());
        args.push(label.trim().to_string());
    }
    run_cli_task(args).await
}

#[tauri::command]
async fn proxy_rename(source: String, label: String) -> Result<Value, String> {
    if source.trim().is_empty() {
        return Err("请先选择订阅".into());
    }
    let mut args: Vec<String> = vec![
        "proxy-rename".into(),
        "--source".into(),
        source.trim().to_string(),
    ];
    if !label.trim().is_empty() {
        args.push("--label".into());
        args.push(label.trim().to_string());
    }
    run_cli_task(args).await
}

#[tauri::command]
async fn proxy_delete(source: String) -> Result<Value, String> {
    if source.trim().is_empty() {
        return Err("请先选择订阅".into());
    }
    run_cli_task(vec![
        "proxy-delete".into(),
        "--source".into(),
        source.trim().to_string(),
    ])
    .await
}

#[tauri::command]
async fn proxy_set_core(path: String) -> Result<Value, String> {
    if path.trim().is_empty() {
        return Err("内核路径不能为空".into());
    }
    run_cli_task(vec![
        "proxy-set-core".into(),
        "--path".into(),
        path.trim().to_string(),
    ])
    .await
}

#[tauri::command]
async fn clash_configs() -> Result<Value, String> {
    run_cli_task(vec!["proxy-discover".into()]).await
}

// ---------------------------------------------------------- extension center

#[tauri::command]
async fn ext_list() -> Result<Value, String> {
    run_cli_task(vec!["ext-list".into()]).await
}

/// Async: the AMO search API is a network call.
#[tauri::command]
async fn ext_search(query: String, limit: usize) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("搜索关键词不能为空".into());
    }
    run_cli_task(vec![
        "ext-search".into(),
        "--query".into(),
        query.to_string(),
        "--limit".into(),
        limit.clamp(1, 40).to_string(),
    ])
    .await
}

/// Async: downloads the XPI from addons.mozilla.org.
#[tauri::command]
async fn ext_install(slug: String) -> Result<Value, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("扩展标识不能为空".into());
    }
    run_cli_task(vec!["ext-install".into(), "--slug".into(), slug.to_string()]).await
}

/// Async: reads/extracts a local XPI or extension folder.
#[tauri::command]
async fn ext_import(path: String) -> Result<Value, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("请选择扩展安装包或文件夹".into());
    }
    run_cli_task(vec!["ext-import".into(), "--path".into(), path.to_string()]).await
}

#[tauri::command]
async fn ext_remove(slug: String) -> Result<Value, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("扩展标识不能为空".into());
    }
    run_cli_task(vec!["ext-remove".into(), "--slug".into(), slug.to_string()]).await
}

// -------------------------------------------------- portable data + packs

/// The one folder that holds every user-owned file. The GUI shows this path
/// and offers to open it, so migration means copying a single directory.
#[tauri::command]
fn data_overview() -> Result<Value, String> {
    let root = project_root();
    let data = storage_root(&root);
    let packs = packs_dir(&root);
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&packs) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_pack = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sfx"))
                .unwrap_or(false);
            if !is_pack {
                continue;
            }
            let meta = entry.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            items.push(serde_json::json!({
                "name": path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "modified": modified,
            }));
        }
    }
    items.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(serde_json::json!({
        "dir": data.display().to_string(),
        "packs_dir": packs.display().to_string(),
        "packs": items,
    }))
}

fn safe_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() { "identity".to_string() } else { trimmed }
}

/// Export into a user-chosen path, or fall back to the managed packs folder.
#[tauri::command]
async fn export_pack(id: String, name: String, output: Option<String>) -> Result<Value, String> {
    let target = if let Some(custom) = output.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        PathBuf::from(custom.trim_matches('"'))
    } else {
        let packs = packs_dir(&project_root());
        let stem = safe_stem(if name.trim().is_empty() { &id } else { name.trim() });
        let mut path = packs.join(format!("{stem}.sfx"));
        if path.exists() {
            let short: String = id.chars().take(8).collect();
            path = packs.join(format!("{stem}-{short}.sfx"));
        }
        path
    };
    let target_text = target.to_string_lossy().to_string();
    let mut value = run_cli_task(vec!["export".into(), id, target_text.clone()]).await?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("file".into(), serde_json::json!(target_text));
    }
    Ok(value)
}

#[tauri::command]
async fn import_pack(file: String) -> Result<Value, String> {
    let file = file.trim().trim_matches('"');
    if file.is_empty() {
        return Err("请选择身份包".into());
    }
    let candidate = PathBuf::from(file);
    let path = if candidate.is_absolute() {
        if !candidate.is_file() {
            return Err(format!("找不到身份包：{}", candidate.display()));
        }
        candidate
    } else {
        if file.contains('/') || file.contains('\\') {
            return Err("身份包名称不合法".into());
        }
        let managed = packs_dir(&project_root()).join(file);
        if !managed.is_file() {
            return Err(format!("找不到身份包：{}", managed.display()));
        }
        managed
    };
    run_cli_task(vec!["import".into(), path.to_string_lossy().to_string()]).await
}

/// Whole-data migration: one zip holding every environment (including saved
/// logins), subscription, setting and the launch history. A bare file name is
/// resolved to the user's Downloads folder by the CLI.
#[tauri::command]
async fn export_all_data(archive: String) -> Result<Value, String> {
    let archive = archive.trim();
    if archive.is_empty() {
        return Err("请填写导出文件名".into());
    }
    run_cli_task(vec![
        "export-all".into(),
        "--archive".into(),
        archive.to_string(),
    ])
    .await
}

#[tauri::command]
async fn import_all_data(archive: String) -> Result<Value, String> {
    let archive = archive.trim();
    if archive.is_empty() {
        return Err("请填写数据包路径".into());
    }
    run_cli_task(vec![
        "import-all".into(),
        "--archive".into(),
        archive.to_string(),
    ])
    .await
}

#[tauri::command]
fn open_data_dir() -> Result<Value, String> {
    let dir = storage_root(&project_root());
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("无法打开数据目录：{e}"))?;
    Ok(serde_json::json!({ "dir": dir.display().to_string() }))
}

#[tauri::command]
async fn launch_history(limit: usize) -> Result<Value, String> {
    let limit = limit.clamp(1, 500).to_string();
    run_cli_task(vec!["history".into(), "--limit".into(), limit]).await
}

// ------------------------------------------------------------ self update

/// Keep the official GitHub API request off the async worker.
#[tauri::command]
async fn check_update() -> Result<update::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| update::check(&project_root()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_update() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| update::download(&project_root()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn update_status() -> update::Status { update::status() }

#[tauri::command]
fn cancel_update() { update::cancel(); }

/// Start the downloaded installer (which keeps the directory page editable)
/// and close the running app so the installer can replace its files.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| update::install(&project_root()))
        .await.map_err(|e| e.to_string())??;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        app.exit(0);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_identities,
            environment_check,
            runtime_status,
            font_overview,
            download_settings,
            save_download_settings,
            cancel_runtime,
            install_runtime,
            select_python,
            setup_local_python,
            pick_python_path,
            pick_dialog,
            reveal_path,
            create_identity,
            edit_identity,
            reorder_identities,
            clone_identity,
            export_cookies,
            rebuild_identity,
            delete_identity,
            launch_identity,
            stop_identity,
            system_proxy,
            proxy_sources,
            proxy_nodes,
            proxy_import,
            proxy_rename,
            proxy_delete,
            proxy_set_core,
            clash_configs,
            ext_list,
            ext_search,
            ext_install,
            ext_import,
            ext_remove,
            data_overview,
            export_pack,
            import_pack,
            export_all_data,
            import_all_data,
            open_data_dir,
            launch_history,
            check_update,
            download_update,
            update_status,
            cancel_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_listing_preserves_paths_with_spaces() {
        let listing = " -V:3.14[-64] *   C:\\Program Files\\Python314\\python.exe\n -V:3.13[-64]     C:\\Python313\\python.exe\n";
        assert_eq!(
            launcher_paths(listing),
            vec![
                PathBuf::from("C:\\Program Files\\Python314\\python.exe"),
                PathBuf::from("C:\\Python313\\python.exe"),
            ]
        );
    }

    #[test]
    fn registry_listing_reads_executable_and_default_install_path() {
        let output = "
HKEY_CURRENT_USER\\SOFTWARE\\Python\\PythonCore\\3.14
    ManagedByPyManager    REG_DWORD    0x1
HKEY_CURRENT_USER\\SOFTWARE\\Python\\PythonCore\\3.14\\Help
    (Default)    REG_SZ    C:\\not-an-interpreter.exe
HKEY_CURRENT_USER\\SOFTWARE\\Python\\PythonCore\\3.14\\InstallPath
    (Default)    REG_SZ    C:\\Users\\kango\\AppData\\Local\\Python\\pythoncore-3.14-64
    ExecutablePath    REG_SZ    C:\\Users\\kango\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe
HKEY_CURRENT_USER\\SOFTWARE\\Python\\PythonCore\\3.13\\InstallPath
    (Default)    REG_SZ    C:\\Python313
";
        assert_eq!(
            registry_paths(output),
            vec![
                PathBuf::from("C:\\Users\\kango\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"),
                PathBuf::from("C:\\Users\\kango\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"),
                PathBuf::from("C:\\Python313\\python.exe"),
            ]
        );
    }

    #[test]
    fn windows_store_stub_is_filtered() {
        assert!(is_windows_store_stub(&PathBuf::from(
            "C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        )));
        assert!(!is_windows_store_stub(&PathBuf::from(
            "C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"
        )));
    }
}
