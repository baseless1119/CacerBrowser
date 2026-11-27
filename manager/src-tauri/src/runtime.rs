//! Download fixed, build-verified runtimes without requiring Python to exist.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::Duration;

#[derive(Clone, Deserialize)]
pub struct Asset {
    pub sha256: String,
    pub size: u64,
    pub unpacked_size: u64,
    pub url: String,
}
#[derive(Clone, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub engine_id: String,
    pub python_version: String,
    pub python: Asset,
    pub fonts: Option<Asset>,
    #[serde(default)]
    pub font_packs: Vec<FontPack>,
    #[serde(default)]
    pub font_index: serde_json::Value,
}
#[derive(Clone, Deserialize)]
pub struct FontPack {
    pub id: String,
    pub name: String,
    pub count: u64,
    #[serde(flatten)]
    pub asset: Asset,
}
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub busy: bool,
    pub message: String,
    pub downloaded: u64,
    pub total: u64,
}
static STATUS: Mutex<Status> = Mutex::new(Status {
    busy: false, message: String::new(), downloaded: 0, total: 0,
});
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn status() -> Status { STATUS.lock().unwrap().clone() }
pub fn cancel() { CANCEL.store(true, Ordering::Relaxed); }
pub(crate) fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) { Err("已取消，可重新尝试".into()) } else { Ok(()) }
}
pub(crate) fn progress(message: &str, downloaded: u64, total: u64) {
    let mut state = STATUS.lock().unwrap();
    state.message = message.into();
    state.downloaded = downloaded;
    state.total = total;
}
pub fn operation<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    {
        let mut state = STATUS.lock().unwrap();
        if state.busy { return Err("另一个运行时安装正在进行".into()); }
        CANCEL.store(false, Ordering::Relaxed);
        *state = Status { busy: true, message: "正在准备".into(), ..Default::default() };
    }
    let result = work();
    let mut state = STATUS.lock().unwrap();
    state.busy = false;
    state.message = match &result { Ok(_) => "准备完成".into(), Err(error) => error.clone() };
    result
}
pub fn resource_dir(root: &Path) -> PathBuf {
    let packaged = root.join("resources/runtime");
    if packaged.join("manifest.json").is_file() { packaged } else { root.join("runtime") }
}
pub fn manifest(root: &Path) -> Result<Manifest, String> {
    let bytes = fs::read(resource_dir(root).join("manifest.json"))
        .map_err(|_| "当前构建没有运行时清单，请使用正式安装包".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !matches!(manifest.schema, 1 | 2) || !valid_hash(&manifest.engine_id)
        || !valid_hash(&manifest.python.sha256)
        || (manifest.schema == 1 && manifest.fonts.as_ref().is_none_or(|a| !valid_hash(&a.sha256)))
        || (manifest.schema == 2 && (manifest.font_packs.is_empty()
            || !manifest.font_packs.iter().any(|p| p.id == "base")
            || manifest.font_packs.iter().any(|p| !valid_hash(&p.asset.sha256)
                || p.id.is_empty() || !p.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')))) {
        return Err("运行时清单无效".into());
    }
    Ok(manifest)
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn cache(root: &Path) -> PathBuf {
    super::storage_root(&root.to_path_buf()).parent().unwrap_or(root).join("runtime-cache")
}
pub fn python_dir(root: &Path, manifest: &Manifest) -> PathBuf {
    cache(root).join(format!("python-{}", &manifest.python.sha256[..16]))
}
pub fn engine_dir(root: &Path, manifest: &Manifest) -> PathBuf {
    if let Some(fonts) = &manifest.fonts {
        cache(root).join(format!("engine-{}-{}", &manifest.engine_id[..16], &fonts.sha256[..16]))
    } else {
        let mut digest = Sha256::new();
        for pack in &manifest.font_packs { digest.update(pack.asset.sha256.as_bytes()); }
        cache(root).join(format!("engine-{}-{:x}", &manifest.engine_id[..16], digest.finalize()))
    }
}
pub(crate) fn complete(directory: &Path, hash: &str) -> bool {
    fs::read_to_string(directory.join(".complete")).map(|s| s == hash).unwrap_or(false)
}
pub fn prepared_engine(root: &Path) -> Option<PathBuf> {
    let manifest = manifest(root).ok()?;
    let directory = engine_dir(root, &manifest);
    (complete(&directory, manifest.fonts.as_ref().map(|a| a.sha256.as_str()).unwrap_or(&manifest.engine_id))
        && directory.join("camoufox.exe").is_file())
        .then_some(directory)
}
pub fn prepared_python(root: &Path) -> Option<PathBuf> {
    let manifest = manifest(root).ok()?;
    let directory = python_dir(root, &manifest);
    let executable = directory.join("python.exe");
    (complete(&directory, &manifest.python.sha256) && executable.is_file()).then_some(executable)
}
pub fn selected_python(root: &Path) -> Option<PathBuf> {
    let path = PathBuf::from(fs::read_to_string(cache(root).join("python-path.txt")).ok()?.trim());
    path.is_file().then_some(path)
}
pub fn save_selected_python(root: &Path, executable: &Path) -> Result<(), String> {
    fs::create_dir_all(cache(root)).map_err(|e| e.to_string())?;
    fs::write(cache(root).join("python-path.txt"), executable.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    super::reset_python_cache();
    Ok(())
}
/// Accept either a `python.exe` file path or a Python installation / venv directory.
pub fn resolve_python_input(input: &str) -> Result<PathBuf, String> {
    let trimmed = input.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("请选择 Python 目录或 python.exe 文件".into());
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        return Ok(path);
    }
    if path.is_dir() {
        let candidates = [
            path.join("python.exe"),
            path.join("Scripts").join("python.exe"),
            path.join(".venv").join("Scripts").join("python.exe"),
            path.join("venv").join("Scripts").join("python.exe"),
            path.join("bin").join("python.exe"),
        ];
        if let Some(found) = candidates.into_iter().find(|candidate| candidate.is_file()) {
            return Ok(found);
        }
        return Err("该目录中未找到 python.exe，请选择 Python 安装目录或 python.exe 文件".into());
    }
    Err("路径不存在，请选择有效的 Python 目录或 python.exe 文件".into())
}
const DEP_CHECK_SCRIPT: &str = r#"import importlib
missing = []
for mod in ("camoufox", "playwright", "fpgen", "PIL", "socks"):
    try:
        importlib.import_module(mod)
    except Exception:
        missing.append(mod)
if missing:
    print(", ".join(missing))
    raise SystemExit(1)
"#;
/// Verify that all required runtime modules can be imported. Returns `Err(missing)`
/// listing the missing module names or failure reason.
pub fn missing_dependencies(python: &Path, cwd: &Path, timeout: Duration) -> Result<(), String> {
    match super::run_output_with_timeout(python, &["-c", DEP_CHECK_SCRIPT], cwd, timeout) {
        Some((true, _, _)) => Ok(()),
        Some((false, stdout, stderr)) => {
            let detail = stdout.trim();
            if !detail.is_empty() {
                Err(detail.to_string())
            } else {
                let err = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("依赖检查失败");
                Err(err.trim().to_string())
            }
        }
        None => Err("依赖检查超时".into()),
    }
}
pub fn python_minor_version(python: &Path) -> Result<(u32, u32, String), String> {
    let script = "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.version.split()[0]}')";
    let cwd = python.parent().unwrap_or_else(|| Path::new("."));
    let Some((true, stdout, _)) = super::run_output_with_timeout(python, &["-c", script], cwd, Duration::from_secs(10)) else {
        return Err("无法执行该 Python 解释器，请确认选择了有效的 python.exe".into());
    };
    let line = stdout.trim();
    let Some((mm, full)) = line.split_once('|') else {
        return Err("无法识别该 Python 版本".into());
    };
    let mut parts = mm.split('.');
    let major = parts.next().and_then(|v| v.parse::<u32>().ok()).ok_or("无法解析 Python 主版本号")?;
    let minor = parts.next().and_then(|v| v.parse::<u32>().ok()).ok_or("无法解析 Python 次版本号")?;
    Ok((major, minor, full.to_string()))
}
pub fn select_python(root: &Path, path: &str) -> Result<PathBuf, String> {
    let executable = resolve_python_input(path)?;
    if let Err(missing) = missing_dependencies(&executable, &super::code_root(&root.to_path_buf()), Duration::from_secs(20)) {
        return Err(format!("该 Python 缺少运行依赖（{missing}），请点「一键安装依赖」复用此 Python 自动配置"));
    }
    save_selected_python(root, &executable)?;
    Ok(executable)
}
const DIRECT_RUNTIME_PACKAGES: [&str; 6] = [
    "camoufox[geoip]",
    "playwright",
    "fpgen",
    "Pillow",
    "PySocks",
    "PyYAML",
];
const PYPI_MIRRORS: [(&str, &str, &str); 2] = [
    ("https://pypi.tuna.tsinghua.edu.cn/simple", "pypi.tuna.tsinghua.edu.cn", "清华镜像"),
    ("https://mirrors.aliyun.com/pypi/simple/", "mirrors.aliyun.com", "阿里云镜像"),
];
fn run_cancellable_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    label: &str,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    cancelled()?;
    let mut child = super::silent_command(program)
        .args(args)
        .current_dir(cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动进程：{e}"))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let label_owned = label.to_string();
    let stdout_thread = std::thread::spawn(move || {
        let mut last = String::new();
        if let Some(pipe) = stdout_pipe {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let text = line.trim();
                if text.is_empty() { continue; }
                last = text.to_string();
                if text.starts_with("Collecting ")
                    || text.starts_with("Downloading ")
                    || text.starts_with("Installing collected")
                    || text.starts_with("Using cached ")
                {
                    let summary: String = text.chars().take(64).collect();
                    progress(&format!("{label_owned} · {summary}"), 0, 0);
                }
            }
        }
        last
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut lines = Vec::new();
        if let Some(pipe) = stderr_pipe {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let text = line.trim();
                if !text.is_empty() {
                    lines.push(text.to_string());
                    if lines.len() > 20 { lines.remove(0); }
                }
            }
        }
        lines.join("\n")
    });
    let started = std::time::Instant::now();
    let status = loop {
        if CANCEL.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("已取消，可重新尝试".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("执行超时，请检查网络连接".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待进程失败：{e}"));
            }
        }
    };
    let last_stdout = stdout_thread.join().unwrap_or_default();
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = stderr_text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or(last_stdout);
        Err(if detail.is_empty() { format!("退出码 {}", status.code().unwrap_or(-1)) } else { detail })
    }
}
fn is_resolution_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no matching distribution")
        || lower.contains("could not find a version")
        || lower.contains("requires-python")
        || lower.contains("ignored the following versions")
}
/// Reuse an existing local Python: if it already has all dependencies, select it directly;
/// otherwise create an isolated venv under `runtime-cache` from that Python and install
/// dependencies via pip (avoiding downloading the full standalone Python archive).
pub fn setup_local_python(root: &Path, input_path: Option<&str>, proxy: &str) -> Result<PathBuf, String> {
    let base_python = match input_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => resolve_python_input(text)?,
        None => super::best_local_python(root)
            .ok_or("未自动检测到本机 Python，请先选择本地 Python 目录或手动安装")?,
    };
    let code = super::code_root(&root.to_path_buf());
    progress("正在检查本机 Python 版本…", 0, 0);
    let (major, minor, full_version) = python_minor_version(&base_python)?;
    if major != 3 || minor < 10 {
        return Err(format!("该 Python 版本过低（{full_version}），需要 Python 3.10 及以上版本"));
    }
    progress(&format!("正在检查 Python {full_version} 已有依赖…"), 0, 0);
    if missing_dependencies(&base_python, &code, Duration::from_secs(20)).is_ok() {
        save_selected_python(root, &base_python)?;
        return Ok(base_python);
    }
    let venv_key = format!(
        "{:x}",
        Sha256::digest(format!("{}|{}", base_python.to_string_lossy().to_ascii_lowercase(), full_version).as_bytes())
    );
    let venv_id = &venv_key[..16];
    let venv_dir = cache(root).join(format!("local-venv-{venv_id}"));
    let venv_python = venv_dir.join("Scripts").join("python.exe");
    if complete(&venv_dir, &venv_key)
        && venv_python.is_file()
        && missing_dependencies(&venv_python, &code, Duration::from_secs(20)).is_ok()
    {
        save_selected_python(root, &venv_python)?;
        return Ok(venv_python);
    }
    cancelled()?;
    progress(&format!("正在基于本机 Python {full_version} 创建独立环境…"), 0, 0);
    fs::create_dir_all(cache(root)).map_err(|e| e.to_string())?;
    if venv_dir.exists() {
        let _ = fs::remove_dir_all(&venv_dir);
    }
    let venv_result = (|| -> Result<PathBuf, String> {
        run_cancellable_command(
            &base_python,
            &["-m".into(), "venv".into(), venv_dir.to_string_lossy().into_owned()],
            &code,
            Duration::from_secs(120),
            "正在创建虚拟环境",
        ).map_err(|e| format!("基于本机 Python 创建独立环境失败：{e}"))?;
        if !venv_python.is_file() {
            return Err("虚拟环境创建不完整（未找到 Scripts\\python.exe）".into());
        }
        if !super::run_with_timeout(&venv_python, &["-m", "pip", "--version"], &venv_dir, Duration::from_secs(20)).unwrap_or(false) {
            progress("正在初始化 pip…", 0, 0);
            run_cancellable_command(
                &venv_python,
                &["-m".into(), "ensurepip".into(), "--upgrade".into()],
                &venv_dir,
                Duration::from_secs(120),
                "正在初始化 pip",
            ).map_err(|e| format!("初始化 pip 失败：{e}"))?;
        }
        let settings = download_settings(root);
        let explicit_proxy = if proxy.trim().is_empty() { settings.proxy } else { proxy.to_string() };
        let system = super::system_proxy().ok()
            .filter(|sys| sys["enabled"].as_bool() == Some(true))
            .and_then(|sys| sys["server"].as_str().and_then(windows_proxy));
        let mut routes: Vec<(Option<&str>, Option<&str>, String, String)> = Vec::new();
        if !explicit_proxy.trim().is_empty() {
            routes.push((None, None, explicit_proxy.trim().to_string(), "指定代理".into()));
        }
        for (url, host, label) in PYPI_MIRRORS {
            routes.push((Some(url), Some(host), String::new(), label.into()));
        }
        if let Some(sys_proxy) = system {
            routes.push((None, None, sys_proxy, "系统代理".into()));
        }
        routes.push((None, None, String::new(), "官方源".into()));

        let requirements_file = resource_dir(root).join("requirements.txt");
        let use_locked = requirements_file.is_file()
            && manifest(root).ok().is_some_and(|m| m.python_version == format!("{major}.{minor}"));
        let mut plans: Vec<Vec<String>> = Vec::new();
        if use_locked {
            plans.push(vec!["-r".into(), requirements_file.to_string_lossy().into_owned()]);
        }
        plans.push(DIRECT_RUNTIME_PACKAGES.iter().map(|s| (*s).to_string()).collect());

        let mut installed = false;
        let mut last_error = String::new();
        'plans: for plan in plans {
            for (index_url, trusted_host, route_proxy, route_label) in &routes {
                cancelled()?;
                let label = format!("正在安装依赖 · {route_label}");
                progress(&label, 0, 0);
                let mut args: Vec<String> = vec![
                    "-m".into(),
                    "pip".into(),
                    "install".into(),
                    "--prefer-binary".into(),
                    "--default-timeout".into(),
                    "30".into(),
                    "--retries".into(),
                    "2".into(),
                ];
                if let Some(url) = index_url {
                    args.push("-i".into());
                    args.push((*url).into());
                }
                if let Some(host) = trusted_host {
                    args.push("--trusted-host".into());
                    args.push((*host).into());
                }
                if !route_proxy.is_empty() {
                    args.push("--proxy".into());
                    args.push(route_proxy.clone());
                }
                args.extend(plan.iter().cloned());
                match run_cancellable_command(&venv_python, &args, &venv_dir, Duration::from_secs(600), &label) {
                    Ok(()) => {
                        installed = true;
                        break 'plans;
                    }
                    Err(error) => {
                        cancelled()?;
                        last_error = format!("{route_label}：{error}");
                        if plan.first().map(String::as_str) == Some("-r") && is_resolution_error(&error) {
                            break;
                        }
                    }
                }
            }
        }
        if !installed {
            return Err(format!("所有下载线路均失败，无法通过 pip 安装依赖。{last_error}"));
        }
        progress("正在验证依赖…", 0, 0);
        if let Err(missing) = missing_dependencies(&venv_python, &code, Duration::from_secs(30)) {
            return Err(format!("依赖安装后验证失败（缺少：{missing}）"));
        }
        cancelled()?;
        fs::write(venv_dir.join(".complete"), &venv_key).map_err(|e| e.to_string())?;
        save_selected_python(root, &venv_python)?;
        Ok(venv_python)
    })();
    if venv_result.is_err() {
        let _ = fs::remove_dir_all(&venv_dir);
    }
    venv_result
}
/// Open a native Windows folder, open-file, or save-file dialog without extra crate dependencies.
/// All user-facing strings are passed via environment variables to avoid PowerShell quoting issues.
pub fn pick_dialog(
    kind: &str,
    title: Option<&str>,
    filter: Option<&str>,
    default_name: Option<&str>,
    default_dir: Option<&str>,
) -> Result<Option<String>, String> {
    let script = match kind {
        "dir" | "open_dir" => r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = if ($env:CACER_DLG_TITLE) { $env:CACER_DLG_TITLE } else { '选择文件夹' }
$dialog.ShowNewFolderButton = $false
if ($env:CACER_DLG_DIR -and (Test-Path -LiteralPath $env:CACER_DLG_DIR)) {
    $dialog.SelectedPath = $env:CACER_DLG_DIR
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
}
$owner.Dispose()"#,
        "file" | "open_file" => r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = if ($env:CACER_DLG_TITLE) { $env:CACER_DLG_TITLE } else { '选择文件' }
$dialog.Filter = if ($env:CACER_DLG_FILTER) { $env:CACER_DLG_FILTER } else { '所有文件 (*.*)|*.*' }
if ($env:CACER_DLG_DIR -and (Test-Path -LiteralPath $env:CACER_DLG_DIR)) {
    $dialog.InitialDirectory = $env:CACER_DLG_DIR
}
if ($env:CACER_DLG_NAME) {
    $dialog.FileName = $env:CACER_DLG_NAME
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.FileName)
}
$owner.Dispose()"#,
        "save_file" => r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = if ($env:CACER_DLG_TITLE) { $env:CACER_DLG_TITLE } else { '保存文件' }
$dialog.Filter = if ($env:CACER_DLG_FILTER) { $env:CACER_DLG_FILTER } else { '所有文件 (*.*)|*.*' }
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
if ($env:CACER_DLG_DIR -and (Test-Path -LiteralPath $env:CACER_DLG_DIR)) {
    $dialog.InitialDirectory = $env:CACER_DLG_DIR
}
if ($env:CACER_DLG_NAME) {
    $dialog.FileName = $env:CACER_DLG_NAME
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.FileName)
}
$owner.Dispose()"#,
        _ => return Err("未知选择类型".into()),
    };
    let mut cmd = super::silent_command("powershell.exe");
    cmd.args(["-NoProfile", "-STA", "-Command", script])
        .env("CACER_DLG_TITLE", title.unwrap_or(""))
        .env("CACER_DLG_FILTER", filter.unwrap_or(""))
        .env("CACER_DLG_NAME", default_name.unwrap_or(""))
        .env("CACER_DLG_DIR", default_dir.unwrap_or(""));
    let output = cmd
        .output()
        .map_err(|e| format!("无法打开系统选择窗口：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() { "打开系统选择窗口失败".into() } else { err });
    }
    let chosen = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!chosen.is_empty()).then_some(chosen))
}
pub fn pick_python_location(kind: &str) -> Result<Option<String>, String> {
    match kind {
        "dir" => pick_dialog(
            "open_dir",
            Some("选择本机 Python 安装目录（包含 python.exe 或 Scripts\\python.exe）"),
            None,
            None,
            None,
        ),
        "file" => pick_dialog(
            "open_file",
            Some("选择 python.exe"),
            Some("Python 解释器 (python.exe)|python.exe|可执行文件 (*.exe)|*.exe"),
            None,
            None,
        ),
        _ => Err("未知选择类型".into()),
    }
}
fn digest_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 128];
    loop {
        cancelled()?;
        let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 { break; }
        digest.update(&buffer[..length]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct DownloadSettings {
    pub proxy: String,
    pub mirror: String,
}
pub fn download_settings(root: &Path) -> DownloadSettings {
    fs::read(cache(root).join("download-settings.json")).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
pub fn save_download_settings(root: &Path, settings: &DownloadSettings) -> Result<(), String> {
    if !settings.proxy.trim().is_empty() {
        reqwest::Proxy::all(settings.proxy.trim()).map_err(|_| "下载代理格式无效")?;
    }
    if !settings.mirror.trim().is_empty() {
        let url = reqwest::Url::parse(settings.mirror.trim()).map_err(|_| "镜像地址格式无效")?;
        if url.scheme() != "https" || url.host_str().is_none() || url.query().is_some() || url.fragment().is_some() {
            return Err("镜像需为 HTTPS 前缀，不含查询参数或片段".into());
        }
    }
    fs::create_dir_all(cache(root)).map_err(|e| e.to_string())?;
    fs::write(cache(root).join("download-settings.json"),
        serde_json::to_vec(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub(crate) fn windows_proxy(server: &str) -> Option<String> {
    let value = server.split(';').find_map(|entry| entry.strip_prefix("https="))
        .or_else(|| server.split(';').find_map(|entry| entry.strip_prefix("http=")))
        .or_else(|| (!server.contains('=')).then_some(server))?;
    Some(if value.contains("://") { value.to_string() } else { format!("http://{value}") })
}
/// Public GitHub proxies tried in order before touching GitHub directly.
/// They are hard-coded so a download never depends on user input.
pub(crate) const MIRRORS: [&str; 5] = [
    "https://ghfast.top",
    "https://gh-proxy.com",
    "https://github.moeyy.xyz",
    "https://ghproxy.net",
    "https://gh.llkk.cc",
];
pub(crate) fn download(root: &Path, asset: &Asset, proxy: &str, name: &str) -> Result<PathBuf, String> {
    let settings = download_settings(root);
    let proxy = if proxy.trim().is_empty() { settings.proxy } else { proxy.to_string() };
    let system = super::system_proxy().ok()
        .filter(|system| system["enabled"].as_bool() == Some(true))
        .and_then(|system| system["server"].as_str().and_then(windows_proxy));
    let mut routes: Vec<(String, String, bool, String)> = Vec::new();
    // Mirrors first: GitHub itself is often unreachable without a proxy.
    for mirror in MIRRORS {
        routes.push((format!("{mirror}/{}", asset.url), String::new(), true,
            format!("镜像 {}", mirror.trim_start_matches("https://"))));
    }
    if !proxy.trim().is_empty() {
        routes.push((asset.url.clone(), proxy, false, "指定代理".into()));
    }
    if let Some(system) = system {
        routes.push((asset.url.clone(), system, false, "系统代理".into()));
    }
    routes.push((asset.url.clone(), String::new(), false, "系统 / 环境代理".into()));
    routes.push((asset.url.clone(), String::new(), true, "直连".into()));
    let mut last_error = String::new();
    for (url, proxy, direct, route) in routes {
        cancelled()?;
        let label = format!("{name} · {route}");
        progress(&label, 0, asset.size);
        match download_attempt(root, asset, &url, &proxy, direct, &label) {
            Ok(path) => return Ok(path),
            Err(error) => {
                cancelled()?;
                last_error = format!("{route}：{error}");
            }
        }
    }
    Err(format!("所有下载线路均失败，请检查代理或镜像。{last_error}"))
}
fn download_attempt(root: &Path, asset: &Asset, request_url: &str, proxy: &str, direct: bool, name: &str) -> Result<PathBuf, String> {
    let url = reqwest::Url::parse(&asset.url).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("github.com")
        || !url.path().starts_with("/baseless1119/CacerBrowser/releases/download/") {
        return Err("运行时下载地址不属于项目 Release".into());
    }
    let downloads = cache(root).join("downloads");
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let target = downloads.join(format!("{}.zip", asset.sha256));
    if target.is_file() && fs::metadata(&target).map_err(|e| e.to_string())?.len() == asset.size
        && digest_file(&target)? == asset.sha256 {
        return Ok(target);
    }
    let partial = downloads.join(format!("{}.partial", asset.sha256));
    let result = tauri::async_runtime::block_on(async {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(7200))
            .user_agent("Cacer-runtime");
        if direct { builder = builder.no_proxy(); }
        if !proxy.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| e.to_string())?);
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        let mut response = client.get(request_url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("下载失败：{e}"))?;
        if let Some(length) = response.content_length() {
            if length != asset.size { return Err("下载大小与清单不一致".into()); }
        }
        let mut output = File::create(&partial).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut downloaded = 0;
        progress(name, 0, asset.size);
        loop {
            cancelled()?;
            let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? else { break; };
            downloaded += chunk.len() as u64;
            if downloaded > asset.size { return Err("下载内容超出预期大小".into()); }
            output.write_all(&chunk).map_err(|e| e.to_string())?;
            digest.update(&chunk);
            progress(name, downloaded, asset.size);
        }
        if downloaded != asset.size || format!("{:x}", digest.finalize()) != asset.sha256 {
            return Err("SHA256 校验失败，请重试".into());
        }
        drop(output);
        if target.exists() { fs::remove_file(&target).map_err(|e| e.to_string())?; }
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        Ok(target.clone())
    });
    if result.is_err() { let _ = fs::remove_file(&partial); }
    result
}
pub(crate) fn extract(archive: &Path, target: &Path, limit: u64) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for index in 0..archive.len() {
        cancelled()?;
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("压缩包包含非法路径")?;
        // Windows also interprets backslashes, drive letters and ADS separators.
        if relative.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
            || entry.name().contains(['\\', ':'])
            || entry.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Err("压缩包包含非法路径".into());
        }
        total = total.checked_add(entry.size()).ok_or("解压大小溢出")?;
        if total > limit { return Err("解压大小超出清单".into()); }
        let output = target.join(relative);
        if entry.is_dir() { fs::create_dir_all(output).map_err(|e| e.to_string())?; continue; }
        fs::create_dir_all(output.parent().ok_or("非法路径")?).map_err(|e| e.to_string())?;
        let mut file = File::create(&output).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 128 * 1024];
        let mut written = 0u64;
        loop {
            cancelled()?;
            let length = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if length == 0 { break; }
            written += length as u64;
            if written > entry.size() { return Err("文件解压大小无效".into()); }
            file.write_all(&buffer[..length]).map_err(|e| e.to_string())?;
        }
    }
    if total != limit { return Err("解压内容不完整".into()); }
    Ok(())
}
pub(crate) fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        cancelled()?;
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), target.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn install(root: &Path, kind: &str, proxy: &str) -> Result<PathBuf, String> {
    let manifest = manifest(root)?;
    let (asset, target, label) = match kind {
        "python" => (&manifest.python, python_dir(root, &manifest), "正在下载 Python 与依赖"),
        "fonts" => (manifest.fonts.as_ref().ok_or("请选择语言字体包")?, engine_dir(root, &manifest), "正在下载浏览器字体"),
        _ => return Err("未知运行时类型".into()),
    };
    if complete(&target, &asset.sha256) { return Ok(target); }
    let archive = download(root, asset, proxy, label)?;
    progress("正在解压并验证", asset.size, asset.size);
    let staging = target.with_extension("staging");
    if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        if kind == "fonts" {
            copy_tree(&resource_dir(root).join("camoufox"), &staging)?;
            extract(&archive, &staging.join("fonts"), asset.unpacked_size)?;
        } else {
            extract(&archive, &staging, asset.unpacked_size)?;
            if !super::run_with_timeout(&staging.join("python.exe"), &["-c", "import camoufox, playwright, fpgen, PIL, socks"], &staging, Duration::from_secs(30)).unwrap_or(false) {
                return Err("Python 依赖验证失败".into());
            }
        }
        cancelled()?;
        fs::write(staging.join(".complete"), &asset.sha256).map_err(|e| e.to_string())?;
        if target.exists() { fs::remove_dir_all(&target).map_err(|e| e.to_string())?; }
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&archive);
        Ok(target)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(staging); }
    result
}
fn ps_quote(text: &str) -> String { format!("'{}'", text.replace('\'', "''")) }
pub fn guide(root: &Path) -> Result<String, String> {
    let manifest = manifest(root).ok();
    let version = manifest.as_ref().map(|m| m.python_version.as_str()).unwrap_or("3.12");
    let suffix = manifest.as_ref().map(|m| &m.python.sha256[..16]).unwrap_or("local");
    let destination = cache(root).join(format!("manual-python-{suffix}"));
    let requirements = resource_dir(root).join("requirements.txt");
    let install_cmd = if requirements.is_file() {
        format!("& {} -m pip install -r {}", ps_quote(&destination.join("Scripts/python.exe").to_string_lossy()), ps_quote(&requirements.to_string_lossy()))
    } else {
        format!("& {} -m pip install camoufox[geoip] playwright fpgen Pillow PySocks PyYAML", ps_quote(&destination.join("Scripts/python.exe").to_string_lossy()))
    };
    Ok(format!(
        "# 若未安装 Python，请先执行（或从 python.org 安装 Python {} x64）\nwinget install -e --id Python.Python.{}\n\n# 已有 Python 时，可直接在下方选择其目录一键安装依赖，或在 PowerShell 手动执行：\npython -m venv {}\n{}\n\n# 安装完成后，选择或填入此解释器路径\n# {}",
        version, version,
        ps_quote(&destination.to_string_lossy()),
        install_cmd,
        destination.join("Scripts/python.exe").display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("cacer-runtime-test-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn archive(path: &Path, name: &str, bytes: &[u8]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        writer.start_file(name, SimpleFileOptions::default()).unwrap();
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap();
    }
    #[test]
    fn extraction_rejects_windows_and_parent_paths() {
        let dir = TestDir::new();
        for name in ["../escape", "C:/escape", "fonts/file:stream", "fonts\\escape"] {
            let zip = dir.0.join("bad.zip");
            archive(&zip, name, b"test");
            assert!(extract(&zip, &dir.0.join("out"), 4).is_err(), "{name}");
        }
        assert!(!dir.0.join("escape").exists());
    }
    #[test]
    fn extraction_checks_size_and_crc() {
        let dir = TestDir::new();
        let zip = dir.0.join("good.zip");
        archive(&zip, "fonts/font.ttf", b"font");
        operation(|| extract(&zip, &dir.0.join("out"), 4)).unwrap();
        assert_eq!(fs::read(dir.0.join("out/fonts/font.ttf")).unwrap(), b"font");
        assert!(operation(|| extract(&zip, &dir.0.join("too-small"), 3)).is_err());
        assert!(operation(|| extract(&zip, &dir.0.join("too-large"), 5)).is_err());
    }
    #[test]
    fn cancellation_and_busy_are_reset_for_retry() {
        assert!(operation(|| {
            assert!(operation(|| Ok(())).is_err());
            cancel();
            cancelled()
        }).is_err());
        assert!(!status().busy);
        assert!(operation(cancelled).is_ok());
    }
    #[test]
    fn cached_font_install_is_verified_and_atomic() {
        let dir = TestDir::new();
        fs::create_dir_all(dir.0.join("core")).unwrap();
        fs::write(dir.0.join("core/cli.py"), "").unwrap();
        let runtime = dir.0.join("runtime");
        fs::create_dir_all(runtime.join("camoufox")).unwrap();
        fs::write(runtime.join("camoufox/camoufox.exe"), "engine").unwrap();
        let zip = dir.0.join("fonts.zip");
        archive(&zip, "font.ttf", b"font");
        let hash = operation(|| digest_file(&zip)).unwrap();
        let asset = serde_json::json!({
            "sha256": hash, "size": fs::metadata(&zip).unwrap().len(), "unpacked_size": 4,
            "url": "https://github.com/baseless1119/CacerBrowser/releases/download/v0.0.0/fonts.zip"
        });
        let manifest = serde_json::json!({"schema": 1, "engine_id": "a".repeat(64),
            "python_version": "3.14", "python": asset, "fonts": asset});
        fs::write(runtime.join("manifest.json"), manifest.to_string()).unwrap();
        let downloads = cache(&dir.0).join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        fs::copy(&zip, downloads.join(format!("{hash}.zip"))).unwrap();
        let target = operation(|| install(&dir.0, "fonts", "")).unwrap();
        assert_eq!(prepared_engine(&dir.0).unwrap(), target);
        assert_eq!(fs::read(target.join("fonts/font.ttf")).unwrap(), b"font");
        assert_eq!(fs::read(target.join("camoufox.exe")).unwrap(), b"engine");
        assert_eq!(operation(|| install(&dir.0, "fonts", "")).unwrap(), target);
        // An invalid asset may never become a completed runtime.
        fs::remove_dir_all(&target).unwrap();
        fs::copy(&zip, downloads.join(format!("{hash}.zip"))).unwrap();
        let mut broken = manifest;
        broken["fonts"]["unpacked_size"] = 3.into();
        fs::write(runtime.join("manifest.json"), broken.to_string()).unwrap();
        assert!(operation(|| install(&dir.0, "fonts", "")).is_err());
        assert!(prepared_engine(&dir.0).is_none());
        assert!(!target.with_extension("staging").exists());
    }
    #[test]
    fn arbitrary_download_hosts_are_rejected() {
        let dir = TestDir::new();
        let asset = Asset { sha256: "a".repeat(64), size: 4, unpacked_size: 4,
            url: "https://example.com/payload.zip".into() };
        assert!(operation(|| download(&dir.0, &asset, "", "test")).is_err());
    }
    #[test]
    fn download_settings_validate_mirrors_and_windows_proxy_lists() {
        assert_eq!(windows_proxy("http=127.0.0.1:8080;https=127.0.0.1:8081").as_deref(),
            Some("http://127.0.0.1:8081"));
        assert_eq!(windows_proxy("socks5://127.0.0.1:1080").as_deref(), Some("socks5://127.0.0.1:1080"));
        let dir = TestDir::new();
        for mirror in ["http://example.com", "file:///payload", "https://example.com/?url="] {
            assert!(save_download_settings(&dir.0, &DownloadSettings { mirror: mirror.into(), proxy: "".into() }).is_err());
        }
        let settings = DownloadSettings { proxy: "socks5://127.0.0.1:1080".into(), mirror: "https://example.com/cache".into() };
        save_download_settings(&dir.0, &settings).unwrap();
        assert_eq!(download_settings(&dir.0).mirror, settings.mirror);
        save_download_settings(&dir.0, &DownloadSettings::default()).unwrap();
        assert!(download_settings(&dir.0).proxy.is_empty());
        assert!(download_settings(&dir.0).mirror.is_empty());
    }
    #[test]
    fn mirror_responses_still_require_the_original_digest() {
        use std::net::TcpListener;
        let dir = TestDir::new();
        let asset = Asset { sha256: format!("{:x}", Sha256::digest(b"good")), size: 4, unpacked_size: 4,
            url: "https://github.com/baseless1119/CacerBrowser/releases/download/v0.0.0/fonts.zip".into() };
        for (body, accepted) in [(b"good", true), (b"evil", false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0u8; 4096];
                socket.read(&mut request).unwrap();
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n").unwrap();
                socket.write_all(body).unwrap();
            });
            let result = operation(|| download_attempt(&dir.0, &asset, &url, "", true, "test"));
            worker.join().unwrap();
            assert_eq!(result.is_ok(), accepted);
            let downloads = cache(&dir.0).join("downloads");
            assert!(!downloads.join(format!("{}.partial", asset.sha256)).exists());
            if let Ok(path) = result { fs::remove_file(path).unwrap(); }
        }
    }
    #[test]
    fn manual_commands_quote_paths() {
        assert_eq!(ps_quote("C:/it's a folder"), "'C:/it''s a folder'");
    }
    #[test]
    fn resolve_python_input_accepts_files_and_directories() {
        let dir = TestDir::new();
        let root_py = dir.0.join("install").join("python.exe");
        fs::create_dir_all(root_py.parent().unwrap()).unwrap();
        fs::write(&root_py, b"").unwrap();
        assert_eq!(resolve_python_input(&format!("\"{}\"", root_py.display())).unwrap(), root_py);
        assert_eq!(resolve_python_input(&root_py.parent().unwrap().to_string_lossy()).unwrap(), root_py);

        let venv_py = dir.0.join("myvenv").join("Scripts").join("python.exe");
        fs::create_dir_all(venv_py.parent().unwrap()).unwrap();
        fs::write(&venv_py, b"").unwrap();
        assert_eq!(resolve_python_input(&dir.0.join("myvenv").to_string_lossy()).unwrap(), venv_py);

        let dot_venv_py = dir.0.join("project").join(".venv").join("Scripts").join("python.exe");
        fs::create_dir_all(dot_venv_py.parent().unwrap()).unwrap();
        fs::write(&dot_venv_py, b"").unwrap();
        assert_eq!(resolve_python_input(&dir.0.join("project").to_string_lossy()).unwrap(), dot_venv_py);

        let empty_dir = dir.0.join("empty");
        fs::create_dir_all(&empty_dir).unwrap();
        assert!(resolve_python_input(&empty_dir.to_string_lossy()).is_err());
        assert!(resolve_python_input(&dir.0.join("missing").to_string_lossy()).is_err());
    }
    #[test]
    fn resolution_error_detection_matches_pip_messages() {
        assert!(is_resolution_error("ERROR: No matching distribution found for numpy==2.5.4"));
        assert!(is_resolution_error("ERROR: Package 'foo' requires a different Python: 3.11.0 not in '>=3.12' (Requires-Python)"));
        assert!(!is_resolution_error("ReadTimeoutError: HTTPSConnectionPool(host='pypi.org', port=443): Read timed out."));
    }
}
