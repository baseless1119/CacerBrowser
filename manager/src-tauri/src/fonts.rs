//! Resolve locale recommendations and actual engine font families to verified packs.
use crate::runtime::{self, Manifest};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn add_locale(manifest: &Manifest, locale: &str, selected: &mut BTreeSet<String>) {
    let locale = locale.replace('_', "-").to_lowercase();
    let locales = &manifest.font_index["locales"];
    let lookup = |key: &str| locales.as_object()?.iter()
        .find(|(name, _)| name.to_lowercase() == key).map(|(_, value)| value);
    let mut parts = locale.split('-').collect::<Vec<_>>();
    let mut found = None;
    while !parts.is_empty() {
        if let Some(groups) = lookup(&parts.join("-")) { found = Some(groups); break; }
        parts.pop();
    }
    if let Some(groups) = found.and_then(Value::as_array) {
        selected.extend(groups.iter().filter_map(Value::as_str).map(str::to_string));
    } else if !locale.is_empty() {
        // Unknown scripts retain the full bundle rather than silently losing glyphs.
        selected.extend(manifest.font_packs.iter().map(|p| p.id.clone()));
    }
}

pub fn required(manifest: &Manifest, request: &Value) -> BTreeSet<String> {
    let mut selected = BTreeSet::from(["base".to_string()]);
    if let Some(country) = request["country"].as_str() {
        if let Some(languages) = manifest.font_index["countries"][country.to_uppercase()].as_array() {
            for language in languages.iter().filter_map(Value::as_str) {
                add_locale(manifest, language, &mut selected);
            }
        }
    }
    for key in ["locale", "ui_locale"] {
        if let Some(locale) = request[key].as_str() { add_locale(manifest, locale, &mut selected); }
    }
    if let Some(languages) = request["languages"].as_array() {
        for language in languages.iter().filter_map(Value::as_str) {
            add_locale(manifest, language, &mut selected);
        }
    }
    if let Some(families) = request["fonts"].as_array() {
        for family in families.iter().filter_map(Value::as_str) {
            if let Some(groups) = manifest.font_index["families"][family.to_lowercase()].as_array() {
                selected.extend(groups.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
    }
    selected.retain(|id| manifest.font_packs.iter().any(|p| p.id == *id));
    selected
}
fn pack_ready(root: &Path, manifest: &Manifest, id: &str, hash: &str) -> bool {
    let engine = runtime::engine_dir(root, manifest);
    if !runtime::complete(&engine.join(".packs").join(id), hash)
        || !engine.join("camoufox.exe").is_file() { return false; }
    manifest.font_index["files"].as_object().is_some_and(|files| files.iter()
        .filter(|(_, info)| info["group"].as_str() == Some(id))
        .all(|(path, info)| fs::metadata(engine.join("fonts").join(path))
            .is_ok_and(|metadata| metadata.is_file() && Some(metadata.len()) == info["size"].as_u64())))
}
pub fn overview(root: &Path, request: &Value) -> Result<Value, String> {
    let manifest = match runtime::manifest(root) {
        Ok(manifest) => manifest,
        Err(_) => return Ok(json!({"development": true, "packs": [], "missing_size": 0, "ready": true, "downloads_dir": runtime::downloads_dir(root).display().to_string()})),
    };
    let downloads_dir = runtime::downloads_dir(root).display().to_string();
    if let Some(asset) = &manifest.fonts {
        let cached = runtime::prepared_engine(root).is_some();
        let file = asset.url.rsplit('/').next().unwrap_or("fonts.zip");
        return Ok(json!({"development": false, "ready": cached,
            "downloads_dir": downloads_dir,
            "missing_size": if cached { 0 } else { asset.size },
            "packs": [{"id": "all", "name": "完整字体（旧版清单）", "count": 0,
                "size": asset.size, "unpacked_size": asset.unpacked_size,
                "url": asset.url, "file": file, "sha256": asset.sha256,
                "cached": cached, "required": true}]}));
    }
    let required = required(&manifest, request);
    let mut missing_size = 0u64;
    let mut ready = true;
    let packs = manifest.font_packs.iter().map(|pack| {
        let cached = pack_ready(root, &manifest, &pack.id, &pack.asset.sha256);
        let needed = required.contains(&pack.id);
        if needed && !cached { missing_size += pack.asset.size; ready = false; }
        let file = pack.asset.url.rsplit('/').next().unwrap_or("fonts.zip");
        json!({"id": pack.id, "name": pack.name, "count": pack.count,
            "size": pack.asset.size, "unpacked_size": pack.asset.unpacked_size,
            "url": pack.asset.url, "file": file, "sha256": pack.asset.sha256,
            "cached": cached, "required": needed})
    }).collect::<Vec<_>>();
    Ok(json!({"development": false, "packs": packs, "missing_size": missing_size, "ready": ready, "downloads_dir": downloads_dir}))
}

fn ensure_engine(root: &Path, manifest: &Manifest) -> Result<PathBuf, String> {
    let target = runtime::engine_dir(root, manifest);
    if runtime::complete(&target, &manifest.engine_id) && target.join("camoufox.exe").is_file() {
        return Ok(target);
    }
    let staging = target.with_extension("staging");
    if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    runtime::copy_tree(&runtime::resource_dir(root).join("camoufox"), &staging)?;
    if !staging.join("camoufox.exe").is_file() { return Err("浏览器核心缺失，请重新安装".into()); }
    fs::write(staging.join(".complete"), &manifest.engine_id).map_err(|e| e.to_string())?;
    if target.exists() { fs::remove_dir_all(&target).map_err(|e| e.to_string())?; }
    fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    Ok(target)
}
fn link_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        runtime::cancelled()?;
        let entry = entry.map_err(|e| e.to_string())?;
        let destination = target.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            link_tree(&entry.path(), &destination)?;
        } else if !destination.exists() {
            // Packs contain disjoint files. Hard links share verified cached bytes.
            if fs::hard_link(entry.path(), &destination).is_err() {
                fs::copy(entry.path(), &destination).map_err(|e| e.to_string())?;
            }
        } else if fs::metadata(&destination).map_err(|e| e.to_string())?.len()
            != entry.metadata().map_err(|e| e.to_string())?.len() {
            return Err("字体缓存文件损坏，请关闭浏览器后清理对应缓存并重试".into());
        }
    }
    Ok(())
}
pub fn install(root: &Path, ids: &[String], proxy: &str) -> Result<PathBuf, String> {
    let manifest = runtime::manifest(root)?;
    if manifest.schema == 1 { return runtime::install(root, "fonts", proxy); }
    let mut ids = ids.iter().cloned().collect::<BTreeSet<_>>();
    ids.insert("base".into());
    if ids.iter().any(|id| !manifest.font_packs.iter().any(|p| p.id == *id)) {
        return Err("未知字体包".into());
    }
    let target = ensure_engine(root, &manifest)?;
    for (position, pack) in manifest.font_packs.iter().filter(|p| ids.contains(&p.id)).enumerate() {
        runtime::cancelled()?;
        if pack_ready(root, &manifest, &pack.id, &pack.asset.sha256) { continue; }
        let cache = runtime::cache(root).join(format!("font-{}", &pack.asset.sha256));
        if !runtime::complete(&cache, &pack.asset.sha256) {
            let label = format!("字体包 {}/{}：{}", position + 1, ids.len(), pack.name);
            let archive = runtime::download(root, &pack.asset, proxy, &label)?;
            runtime::progress(&format!("正在解压：{}", pack.name), pack.asset.size, pack.asset.size);
            let staging = cache.with_extension("staging");
            if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
            let result = (|| {
                runtime::extract(&archive, &staging.join("files"), pack.asset.unpacked_size)?;
                runtime::cancelled()?;
                fs::write(staging.join(".complete"), &pack.asset.sha256).map_err(|e| e.to_string())?;
                if cache.exists() { fs::remove_dir_all(&cache).map_err(|e| e.to_string())?; }
                fs::rename(&staging, &cache).map_err(|e| e.to_string())?;
                Ok::<_, String>(())
            })();
            if result.is_err() { let _ = fs::remove_dir_all(&staging); }
            result?;
            let _ = fs::remove_file(archive);
        }
        link_tree(&cache.join("files"), &target.join("fonts"))?;
        let marker = target.join(".packs").join(&pack.id);
        fs::create_dir_all(&marker).map_err(|e| e.to_string())?;
        fs::write(marker.join(".complete"), &pack.asset.sha256).map_err(|e| e.to_string())?;
        if !pack_ready(root, &manifest, &pack.id, &pack.asset.sha256) {
            return Err("字体包文件与索引不一致".into());
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packs_install_independently_reuse_cache_and_detect_missing_files() {
        use std::io::Write;
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("cacer-font-test-{}", std::process::id()));
        if dir.exists() { fs::remove_dir_all(&dir).unwrap(); }
        fs::create_dir_all(dir.join("core")).unwrap();
        fs::write(dir.join("core/cli.py"), "").unwrap();
        fs::create_dir_all(dir.join("runtime/camoufox")).unwrap();
        fs::write(dir.join("runtime/camoufox/camoufox.exe"), "engine").unwrap();
        let downloads = runtime::cache(&dir).join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let mut packs = Vec::new();
        for id in ["base", "hans"] {
            let archive = dir.join(format!("{id}.zip"));
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            zip.start_file(format!("{id}.ttf"), zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"font").unwrap();
            zip.finish().unwrap();
            let bytes = fs::read(&archive).unwrap();
            let hash = format!("{:x}", Sha256::digest(&bytes));
            fs::copy(&archive, downloads.join(format!("{hash}.zip"))).unwrap();
            packs.push(json!({"id": id, "name": id, "count": 1, "sha256": hash,
                "size": bytes.len(), "unpacked_size": 4,
                "url": format!("https://github.com/baseless1119/CacerBrowser/releases/download/v0.0.0/fonts-{id}.zip")}));
        }
        let manifest = json!({"schema": 2, "engine_id": "b".repeat(64), "python_version": "3.14",
            "python": {"sha256": "a".repeat(64), "size": 1, "unpacked_size": 1, "url": ""},
            "font_packs": packs, "font_index": {
                "locales": {"zh": ["hans"]},
                "files": {"base.ttf": {"group": "base", "size": 4}, "hans.ttf": {"group": "hans", "size": 4}}}});
        fs::write(dir.join("runtime/manifest.json"), manifest.to_string()).unwrap();
        let engine = runtime::operation(|| install(&dir, &[], "")).unwrap();
        assert!(overview(&dir, &json!({})).unwrap()["ready"] == true);
        assert!(overview(&dir, &json!({"locale": "zh-CN"})).unwrap()["ready"] == false);
        assert!(!engine.join("fonts/hans.ttf").exists());
        fs::write(engine.join("unchanged"), "keep").unwrap();
        runtime::operation(|| install(&dir, &["hans".into()], "")).unwrap();
        assert_eq!(fs::read_to_string(engine.join("unchanged")).unwrap(), "keep");
        assert!(overview(&dir, &json!({"locale": "zh-CN"})).unwrap()["ready"] == true);
        fs::remove_file(engine.join("fonts/hans.ttf")).unwrap();
        assert!(overview(&dir, &json!({"locale": "zh-CN"})).unwrap()["ready"] == false);
        // The verified extracted cache repairs a missing link without a download.
        runtime::operation(|| install(&dir, &["hans".into()], "")).unwrap();
        assert!(overview(&dir, &json!({"locale": "zh-CN"})).unwrap()["ready"] == true);
        assert!(runtime::operation(|| install(&dir, &["../outside".into()], "")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn locale_and_actual_families_are_unioned() {
        let asset = json!({"sha256": "a".repeat(64), "size": 1, "unpacked_size": 1, "url": ""});
        let manifest: Manifest = serde_json::from_value(json!({
            "schema": 2, "engine_id": "b".repeat(64), "python_version": "3.14", "python": asset,
            "font_packs": (["base", "hans", "hant", "ja", "latin"].map(|id|
                json!({"id": id, "name": id, "count": 1, "sha256": "a".repeat(64), "size": 1, "unpacked_size": 1, "url": ""}))),
            "font_index": {"locales": {"en": [], "ja": ["ja"], "zh": ["hans"], "zh-Hant": ["hant"]},
                "families": {"example font": ["latin"]}, "countries": {"JP": ["ja", "en"]}}
        })).unwrap();
        let selected = required(&manifest, &json!({"country": "JP", "ui_locale": "zh-CN",
            "locale": "ja-JP", "fonts": ["Example Font"]}));
        assert_eq!(selected, BTreeSet::from(["base", "hans", "ja", "latin"].map(str::to_string)));
        assert!(required(&manifest, &json!({"locale": "zh-Hant-TW"})).contains("hant"));
        assert_eq!(required(&manifest, &json!({"locale": "unknown"})).len(), 5);
    }
}
