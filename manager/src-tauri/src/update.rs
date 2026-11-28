//! Check GitHub for a newer Cacer build and fetch its installer through
//! mirrors that stay reachable from mainland China.
use crate::task::{self, TaskControl, TaskStatus};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

const REPO: &str = "baseless1119/CacerBrowser";
const USER_AGENT: &str = "Cacer-updater";

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub notes: String,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub available: bool,
}

pub type Status = TaskStatus;

static TASK: TaskControl = TaskControl::new();
static RELEASE: Mutex<Option<UpdateInfo>> = Mutex::new(None);
// Keep the verified metadata with the file even if a later update check runs.
static DOWNLOADED: Mutex<Option<(PathBuf, UpdateInfo)>> = Mutex::new(None);

pub fn status() -> Status { TASK.status() }
pub fn cancel() { TASK.cancel(); }

fn progress(message: &str, downloaded: u64, total: u64) {
    TASK.progress(message, downloaded, total);
}

fn updates_dir(root: &Path) -> PathBuf {
    super::runtime::cache(root).join("updates")
}

fn client(proxy: &str, direct: bool, timeout: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(timeout))
        .user_agent(USER_AGENT);
    if direct { builder = builder.no_proxy(); }
    if !proxy.trim().is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| e.to_string())?);
    }
    builder.build().map_err(|e| e.to_string())
}

fn release_digest(asset: &serde_json::Value) -> Result<String, String> {
    let hash = asset["digest"].as_str().and_then(|value| value.strip_prefix("sha256:"))
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("GitHub 官方元数据缺少有效 SHA256，无法安全安装此更新")?;
    Ok(hash.to_ascii_lowercase())
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = core.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
    ))
}

fn validate_asset_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "更新地址无效".to_string())?;
    let prefix = format!("/{REPO}/releases/download/");
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com")
        || !parsed.path().starts_with(&prefix)
        || !parsed.path().to_ascii_lowercase().ends_with("-setup.exe") {
        return Err("更新地址不属于项目 Release".into());
    }
    Ok(())
}

fn parse_release(release: &serde_json::Value, current: &str) -> Result<UpdateInfo, String> {
    let tag = release["tag_name"].as_str().ok_or("版本信息缺少 tag")?;
    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let version = parse_version(&latest).ok_or("版本号格式无效")?;
    let assets = release["assets"].as_array().ok_or("版本信息缺少安装包")?;
    let asset = assets.iter()
        .find(|asset| asset["name"].as_str().unwrap_or("").to_ascii_lowercase().ends_with("-setup.exe"))
        .ok_or("该版本没有 Windows 安装包")?;
    let url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
    validate_asset_url(&url)?;
    let name = asset["name"].as_str().unwrap_or("cacer-setup.exe").to_string();
    let notes: String = release["body"].as_str().unwrap_or("").trim().chars().take(4000).collect();
    Ok(UpdateInfo {
        current: current.into(),
        available: version > parse_version(current).unwrap_or((0, 0, 0)),
        latest,
        notes,
        name,
        size: asset["size"].as_u64().filter(|size| *size > 0).ok_or("安装包大小无效")?,
        sha256: release_digest(asset)?,
        url,
    })
}

/// Only GitHub's HTTPS API may supply the expected digest. Download mirrors
/// must never supply both an executable and the hash used to authenticate it.
pub fn check(root: &Path) -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    let endpoint = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let settings = super::runtime::download_settings(root);
    let mut attempts = vec![(String::new(), false), (String::new(), true)];
    if !settings.proxy.trim().is_empty() { attempts.push((settings.proxy, false)); }
    if let Some(proxy) = task::system_proxy_url() { attempts.push((proxy, false)); }
    let mut last_error = String::new();
    for (attempt_proxy, direct) in attempts {
        let Ok(client) = client(&attempt_proxy, direct, 20) else { continue };
        let response = tauri::async_runtime::block_on(async {
            client.get(&endpoint)
                .header("Accept", "application/vnd.github+json")
                .send().await
                .and_then(|response| response.error_for_status())
        });
        let body = match response {
            Ok(response) if response.url().scheme() == "https"
                && response.url().host_str() == Some("api.github.com") =>
                tauri::async_runtime::block_on(response.text()).map_err(|e| e.to_string()),
            Ok(_) => Err("官方更新元数据被重定向到非 GitHub 地址".into()),
            Err(error) => Err(error.to_string()),
        };
        match body.map_err(|e| format!("请求失败：{e}"))
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|e| format!("解析失败：{e}")))
            .and_then(|json| parse_release(&json, current)) {
            Ok(info) => {
                *RELEASE.lock().unwrap() = Some(info.clone());
                return Ok(info);
            }
            Err(error) => last_error = error,
        }
    }
    Err(format!("无法从 GitHub 官方 API 验证更新：{last_error}"))
}

fn safe_name(name: &str) -> Result<String, String> {
    let lower = name.to_ascii_lowercase();
    if name.is_empty() || name.len() > 120 || !lower.ends_with("-setup.exe")
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) {
        return Err("安装包名称无效".into());
    }
    Ok(name.to_string())
}

fn is_installer(path: &Path, size: u64) -> bool {
    let Ok(metadata) = fs::metadata(path) else { return false };
    if !metadata.is_file() || (size > 0 && metadata.len() != size) { return false; }
    let mut magic = [0u8; 2];
    File::open(path).and_then(|mut file| file.read_exact(&mut magic)).map(|_| magic == *b"MZ").unwrap_or(false)
}

fn verify_installer(path: &Path, size: u64, expected: &str) -> Result<(), String> {
    if !is_installer(path, size) { return Err("更新包不完整，请重新下载".into()); }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 { break; }
        digest.update(&buffer[..length]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err("更新包 SHA256 校验失败，请重新下载".into());
    }
    Ok(())
}

pub fn download(root: &Path) -> Result<String, String> {
    let info = RELEASE.lock().unwrap().clone().ok_or("请先检查更新")?;
    if !info.available { return Err("当前已是最新版本".into()); }
    *DOWNLOADED.lock().unwrap() = None;
    let result = TASK.run("更新下载正在进行", "正在准备下载", info.size, "更新包下载完成", || {
        fetch(root, &info)
    });
    if let Ok(path) = &result { *DOWNLOADED.lock().unwrap() = Some((PathBuf::from(path), info)); }
    result
}

fn fetch(root: &Path, info: &UpdateInfo) -> Result<String, String> {
    let directory = updates_dir(root);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let target = directory.join(safe_name(&info.name)?);
    if verify_installer(&target, info.size, &info.sha256).is_ok() {
        return Ok(target.to_string_lossy().into_owned());
    }
    let settings = super::runtime::download_settings(root);
    let mut routes: Vec<(String, String, bool, String)> = Vec::new();
    if !settings.proxy.trim().is_empty() {
        routes.push((info.url.clone(), settings.proxy.clone(), false, "GitHub · 指定代理".into()));
    }
    if let Some(proxy) = task::system_proxy_url() {
        routes.push((info.url.clone(), proxy, false, "GitHub · 系统代理".into()));
    }
    for mirror in task::MIRRORS {
        let host = mirror.trim_start_matches("https://");
        routes.push((format!("{mirror}/{}", info.url), String::new(), true, format!("镜像 {host}")));
    }
    routes.push((info.url.clone(), String::new(), false, "GitHub".into()));
    routes.push((info.url.clone(), String::new(), true, "GitHub 直连".into()));
    let mut last_error = String::new();
    for (url, proxy, direct, route) in routes {
        TASK.cancelled("已取消下载")?;
        let label = format!("正在下载 Cacer {} · {route}", info.latest);
        progress(&label, 0, info.size);
        match attempt(&target, &url, &proxy, direct, info.size, &info.sha256, &label) {
            Ok(()) => return Ok(target.to_string_lossy().into_owned()),
            Err(error) => {
                TASK.cancelled("已取消下载")?;
                last_error = format!("{route}：{error}");
            }
        }
    }
    Err(format!("所有下载线路均失败，请检查代理或镜像。{last_error}"))
}

fn attempt(target: &Path, url: &str, proxy: &str, direct: bool, size: u64, expected: &str, label: &str) -> Result<(), String> {
    let client = client(proxy, direct, 3600)?;
    let partial = target.with_extension("partial");
    let url = url.to_string();
    let expected = expected.to_string();
    let label = label.to_string();
    let partial_worker = partial.clone();
    let target_worker = target.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = tauri::async_runtime::spawn(async move {
        let outcome = async {
            let mut response = client.get(&url).send().await
                .and_then(|response| response.error_for_status())
                .map_err(|e| format!("连接失败：{e}"))?;
            if let Some(length) = response.content_length() {
                if size > 0 && length != size {
                    return Err(format!("安装包大小不一致（{length} / {size}）"));
                }
            }
            let mut file = File::create(&partial_worker).map_err(|e| e.to_string())?;
            let mut magic = Vec::new();
            let mut digest = Sha256::new();
            let mut downloaded = 0u64;
            loop {
                TASK.cancelled("已取消下载")?;
                let Some(chunk) = response.chunk().await.map_err(|e| format!("下载中断：{e}"))? else { break };
                if magic.len() < 2 {
                    let take = (2 - magic.len()).min(chunk.len());
                    magic.extend_from_slice(&chunk[..take]);
                }
                downloaded += chunk.len() as u64;
                if size > 0 && downloaded > size { return Err("下载内容超出预期大小".into()); }
                digest.update(&chunk);
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                progress(&label, downloaded, size);
            }
            if size > 0 && downloaded != size { return Err("安装包不完整".into()); }
            if magic.as_slice() != b"MZ" { return Err("下载内容不是有效的安装程序".into()); }
            if format!("{:x}", digest.finalize()) != expected {
                return Err("更新包 SHA256 校验失败".into());
            }
            drop(file);
            if target_worker.exists() { fs::remove_file(&target_worker).map_err(|e| e.to_string())?; }
            fs::rename(&partial_worker, &target_worker).map_err(|e| e.to_string())
        }.await;
        let _ = tx.send(outcome);
    });
    let result = loop {
        if TASK.is_cancelled() {
            handle.abort();
            break Err("已取消下载".into());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(outcome) => break outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break Err("下载任务已中止".into()),
        }
    };
    if result.is_err() { let _ = fs::remove_file(&partial); }
    result
}

/// Launch the installer with `/UPDATE` (no `/P`), so the whole wizard shows
/// and the user can still change the install directory.
pub fn install(root: &Path) -> Result<PathBuf, String> {
    let (recorded, info) = DOWNLOADED.lock().unwrap().clone().ok_or("请先下载更新包")?;
    let directory = updates_dir(root).canonicalize().map_err(|_| "更新缓存目录不存在".to_string())?;
    let path = recorded.canonicalize().map_err(|_| "更新包已被移除，请重新下载".to_string())?;
    if !path.starts_with(&directory) || !path.is_file() {
        return Err("更新包路径无效".into());
    }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
    if !name.ends_with("-setup.exe") {
        return Err("更新包名称无效".into());
    }
    verify_installer(&path, info.size, &info.sha256)?;
    Command::new(&path).arg("/UPDATE").spawn().map_err(|e| format!("无法启动安装程序：{e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_ignores_prefix_and_suffix() {
        assert!(parse_version("v0.2.0") > parse_version("0.1.0"));
        assert!(parse_version("1.0.0-beta.1") > parse_version("0.9.9"));
        assert_eq!(parse_version("v1"), Some((1, 0, 0)));
        assert_eq!(parse_version("bad"), None);
    }

    #[test]
    fn release_asset_must_come_from_this_repo() {
        assert!(validate_asset_url(&format!(
            "https://github.com/{REPO}/releases/download/v0.2.0/Cacer_0.2.0_windows_x64-setup.exe")).is_ok());
        for url in [
            "https://github.com/other/repo/releases/download/v1/a-setup.exe",
            "https://example.com/baseless1119/CacerBrowser/releases/download/v1/a-setup.exe",
            "http://github.com/baseless1119/CacerBrowser/releases/download/v1/a-setup.exe",
            "https://github.com/baseless1119/CacerBrowser/releases/download/v1/a.zip",
        ] {
            assert!(validate_asset_url(url).is_err(), "{url}");
        }
        assert!(safe_name("Cacer_0.2.0_windows_x64-setup.exe").is_ok());
        assert!(safe_name("../evil-setup.exe").is_err());
    }

    #[test]
    fn mirror_download_and_cached_file_require_the_trusted_digest() {
        use std::net::TcpListener;
        let directory = std::env::temp_dir().join(format!("cacer-update-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let target = directory.join("test-setup.exe");
        let expected = format!("{:x}", Sha256::digest(b"MZgood"));
        for bytes in [b"MZevil", b"MZgood"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/installer", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let _ = connection.read(&mut request);
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\n").unwrap();
                connection.write_all(bytes).unwrap();
            });
            let result = attempt(&target, &url, "", true, 6, &expected, "test");
            server.join().unwrap();
            if bytes == b"MZevil" {
                assert!(result.unwrap_err().contains("SHA256"));
                assert!(!target.exists());
                assert!(!target.with_extension("partial").exists());
            } else {
                result.unwrap();
                verify_installer(&target, 6, &expected).unwrap();
            }
        }
        fs::write(&target, b"MZevil").unwrap();
        assert!(verify_installer(&target, 6, &expected).is_err());
        // The execution path must recheck the bytes, not just trust download's result.
        let info = UpdateInfo {
            current: "0.1.0".into(), latest: "0.2.0".into(), notes: "".into(),
            name: "test-setup.exe".into(), url: "".into(), size: 6,
            sha256: expected, available: true,
        };
        let root = directory.join("project");
        fs::create_dir_all(root.join("core")).unwrap();
        fs::write(root.join("core/cli.py"), "").unwrap();
        let updates = updates_dir(&root);
        fs::create_dir_all(&updates).unwrap();
        let cached = updates.join("test-setup.exe");
        fs::copy(&target, &cached).unwrap();
        *DOWNLOADED.lock().unwrap() = Some((cached, info));
        assert!(install(&root).unwrap_err().contains("SHA256"));
        *DOWNLOADED.lock().unwrap() = None;
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn release_json_picks_the_windows_installer() {
        let json: serde_json::Value = serde_json::from_str(r#"{
            "tag_name": "v0.2.0",
            "body": "notes",
            "assets": [
                {"name": "fonts.zip", "browser_download_url": "https://github.com/baseless1119/CacerBrowser/releases/download/v0.2.0/fonts.zip", "size": 10},
                {"name": "Cacer_0.2.0_windows_x64-setup.exe", "browser_download_url": "https://github.com/baseless1119/CacerBrowser/releases/download/v0.2.0/Cacer_0.2.0_windows_x64-setup.exe", "size": 20, "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
            ]
        }"#).unwrap();
        let info = parse_release(&json, "0.1.0").unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "0.2.0");
        assert_eq!(info.size, 20);
        assert_eq!(info.sha256, "a".repeat(64));
        let mut missing = json.clone();
        missing["assets"][1]["digest"] = serde_json::Value::Null;
        assert!(parse_release(&missing, "0.1.0").is_err());
        missing["assets"][1]["digest"] = "sha256:invalid".into();
        assert!(parse_release(&missing, "0.1.0").is_err());
        assert!(info.name.ends_with("-setup.exe"));
    }
}