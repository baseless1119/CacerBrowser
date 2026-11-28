"""Clash-style proxy subscriptions backed by a private mihomo core.

The operator imports a Clash configuration (local YAML, subscription URL, or
a profile already on disk from a Clash client). We validate it once, store a
normalised copy under <data_root>/subscriptions/, and expose the node names.
At launch every identity that selected a node from the same subscription
shares one mihomo core: that core exposes one local mixed listener per
identity, each pinned to the identity's node, so different identities use
different exits at the same time without touching the system proxy.

The runtime config handed to mihomo is deliberately minimal: only the chosen
proxies, inbound listeners, and a trivial rule set. Clash profiles frequently
carry rule sets, providers and fixed ports that would either conflict with
other instances or trigger network downloads; none of that is needed to
tunnel browser sessions through individual nodes.
"""

from __future__ import annotations

from contextlib import nullcontext

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .fsutil import write_text_atomic

SETTINGS_FILE = "settings.json"
SUBSCRIPTIONS_DIR = "subscriptions"
_SUBSCRIBE_UA = "clash-verge/v2.0.0"


def data_root(profiles_dir: Path) -> Path:
    """The storage root that also owns profiles/ (settings, subscriptions)."""
    return Path(profiles_dir).resolve().parent


def subscriptions_dir(root: Path) -> Path:
    path = Path(root) / SUBSCRIPTIONS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


LABELS_FILE = "labels.json"


def _labels_path(root: Path) -> Path:
    return subscriptions_dir(root) / LABELS_FILE


def load_labels(root: Path) -> Dict[str, str]:
    path = _labels_path(root)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items() if str(value).strip()}


def _save_labels(root: Path, labels: Dict[str, str]) -> None:
    try:
        write_text_atomic(
            _labels_path(root),
            json.dumps(labels, ensure_ascii=False, indent=2),
        )
    except OSError:
        pass


def rename_source(root: Path, name: str, label: str) -> Dict[str, Any]:
    """Store a human-friendly alias without renaming the YAML file.

    Identities reference subscriptions by file name, so the alias must live
    beside the file instead of replacing it.
    """
    file_name = Path(name).name
    path = subscriptions_dir(root) / file_name
    if not path.is_file():
        raise ValueError(f"订阅不存在：{name}")
    labels = load_labels(root)
    label = (label or "").strip()
    if label:
        labels[file_name] = label
    else:
        labels.pop(file_name, None)
    _save_labels(root, labels)
    return {"name": file_name, "label": labels.get(file_name, path.stem)}


# ------------------------------------------------------------------ settings


def _settings_path(root: Path) -> Path:
    return Path(root) / SETTINGS_FILE


def load_settings(root: Path) -> Dict[str, Any]:
    path = _settings_path(root)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_settings(root: Path, updates: Dict[str, Any]) -> Dict[str, Any]:
    data = load_settings(root)
    data.update(updates)
    write_text_atomic(
        _settings_path(root),
        json.dumps(data, indent=2, ensure_ascii=False),
    )
    return data


# --------------------------------------------------------------------- yaml


def _yaml():
    try:
        import yaml  # noqa: PLC0415 -- optional dependency, reported clearly
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "缺少 PyYAML，请先执行 pip install pyyaml"
        ) from exc
    return yaml


def _decode_text(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def parse_config_text(text: str) -> Dict[str, Any]:
    """Parse a Clash profile; tolerates base64-wrapped subscriptions."""
    yaml = _yaml()
    source = text.strip()
    if not source:
        raise ValueError("配置内容为空")
    config = None
    try:
        config = yaml.safe_load(source)
    except Exception:
        config = None
    if not isinstance(config, dict) or not isinstance(config.get("proxies"), list):
        # Many subscription endpoints return base64(YAML) instead of YAML.
        try:
            decoded = base64.b64decode(re.sub(r"\s+", "", source), validate=True)
            config = yaml.safe_load(_decode_text(decoded))
        except Exception:  # noqa: BLE001 -- not a base64 subscription either
            config = None
    if not isinstance(config, dict):
        raise ValueError("无法解析该配置：不是有效的 Clash YAML")
    proxies = config.get("proxies")
    if not isinstance(proxies, list) or not proxies:
        raise ValueError("该配置中没有 proxies 节点，无法导入")
    if not any(isinstance(item, dict) and item.get("name") for item in proxies):
        raise ValueError("该配置的 proxies 缺少有效节点名称")
    return config


def node_list(config: Dict[str, Any]) -> List[Dict[str, str]]:
    nodes: List[Dict[str, str]] = []
    seen = set()
    for item in config.get("proxies") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        nodes.append({"name": name, "type": str(item.get("type") or "")})
    return nodes


# --------------------------------------------------------------- import io


def _sanitize_name(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")
    return cleaned[:60] or "subscription"


def _name_from_url(url: str) -> str:
    tail = url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    if "." in tail:
        tail = tail.rsplit(".", 1)[0]
    return _sanitize_name(tail)


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": _SUBSCRIBE_UA, "Accept": "*/*"}
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.read()
    except Exception as exc:  # noqa: BLE001 -- surfaced as a user message
        raise RuntimeError(f"下载订阅失败：{exc}") from exc


def import_subscription(
    root: Path,
    *,
    kind: str,
    value: str,
    name: Optional[str] = None,
    label: Optional[str] = None,
    commit_lock=None,
) -> Dict[str, Any]:
    """kind: file | url | text. Returns the stored subscription summary."""
    value = (value or "").strip()
    if not value:
        raise ValueError("订阅内容不能为空")
    if kind == "file":
        path = Path(value).expanduser()
        if not path.is_file():
            raise ValueError(f"文件不存在：{path}")
        raw = path.read_bytes()
        default_name = path.stem
    elif kind == "url":
        if not value.lower().startswith(("http://", "https://")):
            raise ValueError("订阅链接必须以 http:// 或 https:// 开头")
        raw = _fetch(value)
        default_name = _name_from_url(value)
    elif kind == "text":
        raw = value.encode("utf-8")
        default_name = "subscription"
    else:
        raise ValueError(f"不支持的导入方式：{kind}")

    config = parse_config_text(_decode_text(raw))
    nodes = node_list(config)
    if not nodes:
        raise ValueError("该配置中没有可用的代理节点")

    file_name = _sanitize_name(name or default_name)
    if not file_name.lower().endswith((".yaml", ".yml")):
        file_name += ".yaml"
    target = subscriptions_dir(root) / file_name
    yaml = _yaml()
    label_text = (label or "").strip()
    serialized = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
    with commit_lock or nullcontext():
        write_text_atomic(target, serialized)
        if label_text:
            labels = load_labels(root)
            labels[file_name] = label_text
            _save_labels(root, labels)
    return {
        "name": file_name,
        "label": label_text or Path(file_name).stem,
        "path": str(target),
        "updated_at": _mtime(target),
        "nodes": nodes,
        "count": len(nodes),
    }


def _mtime(path: Path) -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(path.stat().st_mtime))
    except OSError:
        return ""


def list_sources(root: Path) -> List[Dict[str, Any]]:
    labels = load_labels(root)
    out: List[Dict[str, Any]] = []
    for path in sorted(subscriptions_dir(root).glob("*")):
        if path.suffix.lower() not in (".yaml", ".yml") or not path.is_file():
            continue
        try:
            config = parse_config_text(path.read_text(encoding="utf-8"))
            count = len(node_list(config))
        except (OSError, ValueError):
            count = 0
        out.append({
            "name": path.name,
            "label": labels.get(path.name, path.stem),
            "path": str(path),
            "updated_at": _mtime(path),
            "nodes": count,
        })
    return out


def load_source(root: Path, name: str) -> Dict[str, Any]:
    path = subscriptions_dir(root) / Path(name).name
    if not path.is_file():
        raise ValueError(f"订阅不存在：{name}")
    return parse_config_text(path.read_text(encoding="utf-8"))


def delete_source(root: Path, name: str) -> Dict[str, Any]:
    path = subscriptions_dir(root) / Path(name).name
    if not path.is_file():
        raise ValueError(f"订阅不存在：{name}")
    path.unlink()
    labels = load_labels(root)
    if labels.pop(path.name, None) is not None:
        _save_labels(root, labels)
    return {"deleted": path.name}


# -------------------------------------------------------- core discovery


def _candidate_cores(root: Path) -> List[Path]:
    code_root = Path(__file__).resolve().parent.parent
    names = ("mihomo.exe", "mihomo") if os.name == "nt" else ("mihomo",)
    dirs: List[Path] = [
        Path(root) / "runtime" / "mihomo",
        Path(root) / "tools",
        Path(root) / "bin",
        Path(root),
        code_root / "runtime" / "mihomo",
        code_root / "tools",
        code_root / "bin",
    ]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data)
        dirs.extend([base / "Cacer" / "mihomo", base / "Cacer", base / "ShadowFox" / "mihomo", base / "ShadowFox", base / "mihomo"])
    app_dir = os.environ.get("APPDATA")
    if app_dir:
        dirs.extend([Path(app_dir) / "Cacer" / "mihomo", Path(app_dir) / "ShadowFox" / "mihomo"])
    out: List[Path] = []
    for directory in dirs:
        for name in names:
            out.append(directory / name)
    return out


def _clash_install_roots() -> List[Path]:
    """Install directories of Clash clients, read from the Windows registry."""
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:  # pragma: no cover - non-Windows Python
        return []
    locations = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    roots: List[Path] = []
    for hive, path in locations:
        try:
            with winreg.OpenKey(hive, path) as parent:
                count = winreg.QueryInfoKey(parent)[0]
                for index in range(count):
                    try:
                        name = winreg.EnumKey(parent, index)
                        with winreg.OpenKey(parent, name) as entry:
                            display = str(winreg.QueryValueEx(entry, "DisplayName")[0])
                            if not re.search(r"clash|mihomo", display, re.I):
                                continue
                            location = ""
                            try:
                                location = str(
                                    winreg.QueryValueEx(entry, "InstallLocation")[0]
                                )
                            except OSError:
                                pass
                            # Registry values are often quoted paths.
                            location = location.strip().strip('"')
                            if not location:
                                try:
                                    icon = str(
                                        winreg.QueryValueEx(entry, "DisplayIcon")[0]
                                    ).strip().strip('"')
                                    location = str(Path(icon).parent)
                                except OSError:
                                    location = ""
                    except OSError:
                        continue
                    if location:
                        roots.append(Path(location))
        except OSError:
            continue
    return roots


def _clash_client_cores() -> List[Path]:
    """Best-effort locations of a Clash Verge bundled mihomo sidecar."""
    if os.name != "nt":
        return []
    bases = [
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("PROGRAMFILES"),
        os.environ.get("PROGRAMFILES(X86)"),
    ]
    roots: List[Path] = []
    for base in bases:
        if not base:
            continue
        base_path = Path(base)
        roots.extend([
            base_path / "Programs" / "Clash Verge",
            base_path / "Clash Verge",
            base_path / "Programs" / "clash-verge",
            base_path / "Programs" / "io.github.clash-verge-rev.clash-verge-rev",
        ])
    roots.extend(_clash_install_roots())
    found: List[Path] = []
    seen = set()
    for root in roots:
        if root in seen or not root.is_dir():
            continue
        seen.add(root)
        for directory in (root, root / "resources"):
            if not directory.is_dir():
                continue
            try:
                entries = directory.iterdir()
            except OSError:
                continue
            for entry in entries:
                lower = entry.name.lower()
                if (
                    entry.is_file()
                    and lower.endswith(".exe")
                    and "mihomo" in lower
                    and entry not in found
                ):
                    found.append(entry)

    def rank(path: Path):
        name = path.name.lower()
        return (
            0 if name in ("mihomo.exe", "verge-mihomo.exe") else 1,
            "alpha" in name or "beta" in name,
            name,
        )

    return sorted(found, key=rank)


def find_core(root: Path) -> Optional[Path]:
    configured = load_settings(root).get("mihomo_path")
    if configured:
        path = Path(str(configured)).expanduser()
        if path.is_file():
            return path
    for candidate in _candidate_cores(root):
        if candidate.is_file():
            return candidate
    which = shutil.which("mihomo")
    if which:
        return Path(which)
    for candidate in _clash_client_cores():
        return candidate
    return None


def detect_core(root: Path) -> Dict[str, Any]:
    path = find_core(root)
    return {
        "found": path is not None,
        "path": str(path) if path else None,
        "searched": [str(p) for p in _candidate_cores(root)],
    }


# ---------------------------------------------------------- clash profiles


def _clash_display_names(directory: Path) -> Dict[str, str]:
    """Map profile file names to the names shown in the Clash client.

    Clash Verge keeps a profiles.yaml next to the profiles folder whose items
    carry the user-visible name; the YAML files themselves are opaque uids.
    """
    index = directory.parent / "profiles.yaml"
    if not index.is_file():
        return {}
    try:
        data = _yaml().safe_load(index.read_text(encoding="utf-8", errors="replace")) or {}
    except Exception:  # noqa: BLE001 -- lenient, fall back to file stems
        return {}
    out: Dict[str, str] = {}
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("file") or f"{item.get('uid') or ''}.yaml")
        title = str(item.get("name") or "").strip()
        if title:
            out[file_name] = title
    return out


def discover_clash_configs() -> List[Dict[str, Any]]:
    """YAML profiles with real nodes that a local Clash client already has."""
    home = Path.home()
    app_data = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    directories = [
        app_data / "io.github.clash-verge-rev.clash-verge-rev" / "profiles",
        app_data / "com.github.clash-verge-rev.clash-verge-rev" / "profiles",
        app_data / "clash-verge" / "profiles",
        app_data / "Clash Verge" / "profiles",
        home / ".config" / "clash" / "profiles",
        home / ".config" / "clash-verge" / "profiles",
        home / ".config" / "mihomo" / "profiles",
    ]
    single_files = [
        home / ".config" / "clash" / "config.yaml",
        home / ".config" / "clash" / "config.yml",
    ]
    seen = set()
    out: List[Dict[str, Any]] = []

    def add(entry: Path, titles: Optional[Dict[str, str]] = None) -> None:
        if entry in seen or not entry.is_file():
            return
        seen.add(entry)
        try:
            count = len(node_list(parse_config_text(
                entry.read_text(encoding="utf-8", errors="replace")
            )))
        except (OSError, ValueError):
            return  # merge/script-only profiles carry no nodes
        if count:
            title = (titles or {}).get(entry.name, "").strip()
            if title.lower().endswith((".yaml", ".yml")):
                title = title.rsplit(".", 1)[0]
            out.append({
                "name": title or entry.stem,
                "file": entry.name,
                "path": str(entry),
                "nodes": count,
            })

    for directory in directories:
        if not directory.is_dir():
            continue
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        titles = _clash_display_names(directory)
        for entry in entries:
            if entry.suffix.lower() in (".yaml", ".yml"):
                add(entry, titles)
    for entry in single_files:
        add(entry)
    return out


# --------------------------------------------------------------- mihomo run
#
# One mihomo core is shared by every identity that routes through the same
# subscription. Each identity owns one inbound listener (mixed HTTP/SOCKS) on
# its own ephemeral port and the listener is pinned to that identity's node,
# so identities still get independent exits while the core (and its ~60 MB
# working set) is started only once.
#
# Ownership is coordinated through a state file per subscription plus the same
# msvcrt lock the CLI uses for identity mutations: the first helper to need the
# core spawns it, later helpers add their listener through the external
# controller API, and the last helper to leave stops the core.


@dataclass
class MihomoHandle:
    pid: int
    port: int
    config_path: Path
    log_path: Path
    source: str = ""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _cores_dir(root: Path) -> Path:
    path = Path(root) / "mihomo" / "cores"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _core_paths(root: Path, source_name: str):
    slug = _sanitize_name(Path(source_name).name)
    base = _cores_dir(root)
    workdir = base / slug
    # The config MUST live inside mihomo's home directory: its control API
    # refuses to load files outside `-d` (unless listed in safe-paths).
    return (
        base / f"{slug}.json",
        workdir / "config.yaml",
        workdir / "mihomo.log",
        workdir,
    )


@contextmanager
def _core_lock(root: Path, timeout: float = 60.0):
    path = Path(root) / "mihomo" / ".core.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            deadline = time.time() + timeout
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.time() >= deadline:
                        raise TimeoutError("代理内核正被其他启动操作占用，请稍后重试")
                    time.sleep(0.1)
        yield
    finally:
        if locked:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    except Exception:
        return False


def _load_core_state(root: Path, source_name: str) -> Optional[Dict[str, Any]]:
    path, *_ = _core_paths(root, source_name)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _save_core_state(root: Path, source_name: str, state: Dict[str, Any]) -> None:
    path, *_ = _core_paths(root, source_name)
    write_text_atomic(path, json.dumps(state, indent=2, ensure_ascii=False))


def _delete_core_state(root: Path, source_name: str) -> None:
    path, *_ = _core_paths(root, source_name)
    try:
        path.unlink()
    except OSError:
        pass


def _api_call(
    state: Dict[str, Any],
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 3.0,
) -> int:
    port = int(state.get("api_port") or 0)
    if port <= 0:
        raise RuntimeError("代理内核缺少控制端口")
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {state.get('secret') or ''}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return int(response.status)


def _core_alive(state: Optional[Dict[str, Any]]) -> bool:
    """True only when the control API answers, proving it is our mihomo."""
    if not state:
        return False
    try:
        _api_call(state, "GET", "/version", timeout=1.0)
        return True
    except Exception:  # noqa: BLE001 -- connection refused / timeout / 401
        return False


def _select_proxy(
    config: Dict[str, Any], node_name: str, alias: str
) -> Optional[Dict[str, Any]]:
    for item in config.get("proxies") or []:
        if isinstance(item, dict) and str(item.get("name")) == node_name:
            selected = dict(item)
            # A chain reference to a provider/group we removed would stop mihomo.
            selected.pop("dialer-proxy", None)
            # Fixed alias: rule syntax can never be broken by a node name that
            # carries a comma or other rule metacharacter.
            selected["name"] = alias
            return selected
    return None


def _shared_runtime_config(
    config: Dict[str, Any],
    entries: Dict[str, Dict[str, Any]],
    api_port: int,
    secret: str,
) -> Dict[str, Any]:
    proxies: List[Dict[str, Any]] = []
    listeners: List[Dict[str, Any]] = []
    for identity_id, entry in entries.items():
        alias = str(entry.get("alias") or f"SHADOWFOX-{identity_id}")
        proxy = _select_proxy(config, str(entry.get("node") or ""), alias)
        if proxy is None:
            continue  # node disappeared from the subscription after a refresh
        proxies.append(proxy)
        listeners.append({
            "name": f"shadowfox-{identity_id}",
            "type": "mixed",
            "port": int(entry["port"]),
            "listen": "127.0.0.1",
            # Pinning the inbound to this identity's proxy is what keeps two
            # environments on the same core from sharing an exit.
            "proxy": alias,
        })
    # Deliberately no DNS block: a profile's fake-ip setup only makes sense
    # with TUN + rules. Through a SOCKS inbound we want mihomo to forward the
    # hostname to the outbound and use the system resolver for node domains.
    return {
        "bind-address": "127.0.0.1",
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "ipv6": False,
        # The control API is how a second helper adds its listener without
        # restarting the core (and without dropping the first browser).
        "external-controller": f"127.0.0.1:{api_port}",
        "secret": secret,
        "proxies": proxies,
        "listeners": listeners,
        # No inbound uses the rule set when every listener pins a proxy; keep
        # a harmless catch-all so mihomo has a valid rule list anyway.
        "rules": ["MATCH,DIRECT"],
    }


def _geo_sources() -> List[Path]:
    """Existing MMDB files from local Clash clients (mihomo needs one)."""
    home = Path.home()
    app_data = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    return [
        app_data / "io.github.clash-verge-rev.clash-verge-rev" / "Country.mmdb",
        app_data / "clash-verge" / "Country.mmdb",
        app_data / "Clash Verge" / "Country.mmdb",
        home / ".config" / "clash" / "Country.mmdb",
        home / ".config" / "mihomo" / "Country.mmdb",
        home / ".config" / "clash-verge" / "Country.mmdb",
    ]


def _ensure_geo(workdir: Path, root: Path) -> None:
    """Seed Country.mmdb so mihomo does not block trying to download it.

    Without a local database mihomo logs "Can't find MMDB, start download" and
    never opens its port until the request finishes. Reuse a Clash client's
    copy, cached once under our runtime dir and hard-linked per identity.
    """
    target = workdir / "Country.mmdb"
    if target.exists():
        return
    source = next((path for path in _geo_sources() if path.is_file()), None)
    if source is None:
        return
    shared = root / "mihomo" / "Country.mmdb"
    try:
        if not shared.is_file():
            shared.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, shared)
        try:
            os.link(shared, target)
        except OSError:
            shutil.copyfile(shared, target)
    except OSError:
        pass


def _tail(path: Path, lines: int = 8) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:]).strip()


def _entry(identity_id: str, node_name: str, port: int) -> Dict[str, Any]:
    return {
        "port": int(port),
        "node": node_name,
        "alias": f"SHADOWFOX-{identity_id}",
        # The helper process that asked for this listener; a dead owner means
        # the browser crashed without releasing and the entry can be pruned.
        "owner": os.getpid(),
    }


def _write_core_config(
    root: Path,
    source_name: str,
    state: Dict[str, Any],
    config: Dict[str, Any],
    entries: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Regenerate the runtime YAML; returns the runtime dict that was written."""
    _, config_path, _, _ = _core_paths(root, source_name)
    runtime = _shared_runtime_config(
        config, entries, int(state["api_port"]), str(state["secret"])
    )
    write_text_atomic(
        config_path, _yaml().safe_dump(runtime, allow_unicode=True, sort_keys=False)
    )
    return runtime


def _apply_core_config(
    root: Path,
    source_name: str,
    state: Dict[str, Any],
    config: Dict[str, Any],
    entries: Dict[str, Dict[str, Any]],
) -> bool:
    """Push a regenerated config to the live core; False means restart it."""
    _write_core_config(root, source_name, state, config, entries)
    config_path = _core_paths(root, source_name)[1]
    try:
        _api_call(state, "PUT", "/configs?force=true", {"path": str(config_path)})
        return True
    except Exception:  # noqa: BLE001 -- old cores / hung API
        return False


def _wait_port(port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def _spawn_core(
    root: Path,
    core: Path,
    source_name: str,
    config: Dict[str, Any],
    entries: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Start a fresh core for all `entries`; returns its persisted state."""
    _, config_path, log_path, workdir = _core_paths(root, source_name)
    workdir.mkdir(parents=True, exist_ok=True)
    _ensure_geo(workdir, root)
    state: Dict[str, Any] = {
        "source": source_name,
        "pid": 0,
        "api_port": _free_port(),
        "secret": uuid.uuid4().hex,
        "config_path": str(config_path),
        "log_path": str(log_path),
        "identities": entries,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    runtime = _write_core_config(root, source_name, state, config, entries)
    # Wait only for the listeners that actually made it into the config: a
    # node that vanished from the subscription is skipped there.
    ports = [int(listener["port"]) for listener in runtime.get("listeners") or []]
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
    # Truncate mihomo.log on each fresh core start so logs never grow without bound.
    log_file = open(log_path, "wb")
    try:
        proc = subprocess.Popen(
            [str(core), "-d", str(workdir), "-f", str(config_path)],
            cwd=str(workdir),
            creationflags=creationflags,
            stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )
    except OSError as exc:
        log_file.close()
        raise RuntimeError(f"无法启动 mihomo：{exc}") from exc
    state["pid"] = proc.pid

    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            detail = _tail(log_path)
            log_file.close()
            message = f"mihomo 启动失败（退出码 {proc.returncode}）"
            if detail:
                message += f"：{detail[-600:]}"
            raise RuntimeError(message)
        if _core_alive(state) and all(_wait_port(port, 0.2) for port in ports):
            log_file.close()
            _save_core_state(root, source_name, state)
            return state
        time.sleep(0.2)
    stop_mihomo(proc.pid)
    log_file.close()
    detail = _tail(log_path)
    if "Can't find MMDB" in detail:
        message = (
            "mihomo 缺少 GeoIP 数据库（Country.mmdb），且无法自动下载；"
            "请先运行一次 Clash Verge 或手动指定内核"
        )
    else:
        message = "mihomo 启动超时（20 秒）"
    if detail:
        message += f"：{detail[-600:]}"
    raise RuntimeError(message)


def acquire_mihomo(
    profiles_dir: Path,
    identity_id: str,
    source_name: str,
    node_name: str,
) -> MihomoHandle:
    """Attach this identity to the shared core for its subscription.

    Starts the core on first use, otherwise adds a listener on a free port.
    Returns once the identity's own inbound accepts connections; the caller
    must later call release_mihomo() so the listener (and, when it was the
    last one, the core) goes away.
    """
    root = data_root(profiles_dir)
    core = find_core(root)
    if core is None:
        raise RuntimeError(
            "未找到 mihomo 内核，请先在“设置 → 代理内核”中指定 mihomo.exe 路径"
        )
    config = load_source(root, source_name)
    if _select_proxy(config, node_name, "probe") is None:
        raise ValueError(f"订阅中没有名为“{node_name}”的节点")

    with _core_lock(root):
        entries: Dict[str, Dict[str, Any]] = {}
        state = _load_core_state(root, source_name)
        if not _core_alive(state):
            # Never taskkill this pid: an unresponsive state file may point at
            # a pid the OS reused for an unrelated process.
            state = None
        if state is not None:
            entries = {
                key: value
                for key, value in (state.get("identities") or {}).items()
                if isinstance(value, dict)
            }
            for key in list(entries):
                if key != identity_id and not _pid_alive(int(entries[key].get("owner") or 0)):
                    entries.pop(key)
            existing = entries.get(identity_id) or {}
            port = int(existing.get("port") or 0) or _free_port()
            entries[identity_id] = _entry(identity_id, node_name, port)
            if _apply_core_config(root, source_name, state, config, entries) and _wait_port(port, 5):
                state["identities"] = entries
                _save_core_state(root, source_name, state)
                return MihomoHandle(
                    pid=int(state.get("pid") or 0),
                    port=port,
                    config_path=Path(state["config_path"]),
                    log_path=Path(state["log_path"]),
                    source=source_name,
                )
            # Reload failed: reap this core and start a fresh one with the
            # merged listener set (the other helpers reconnect automatically).
            stop_mihomo(int(state.get("pid") or 0))
            _delete_core_state(root, source_name)
        else:
            entries = {identity_id: _entry(identity_id, node_name, _free_port())}

        state = _spawn_core(root, core, source_name, config, entries)
        port = int(state["identities"][identity_id]["port"])
        return MihomoHandle(
            pid=int(state.get("pid") or 0),
            port=port,
            config_path=Path(state["config_path"]),
            log_path=Path(state["log_path"]),
            source=source_name,
        )


def release_mihomo(
    profiles_dir: Path,
    identity_id: str,
    source_name: Optional[str] = None,
) -> None:
    """Drop one identity's listener; stop the core when nobody is left.

    Safe to call twice (helper exit plus an explicit stop) and safe when the
    subscription name is unknown: callers without one fall back to scanning
    every core state.
    """
    root = data_root(profiles_dir)
    if not Path(root).is_dir():
        return
    try:
        # A short timeout keeps the GUI polling path responsive; a skipped
        # release is harmless because the next acquire prunes dead owners.
        with _core_lock(root, timeout=5.0):
            _release_locked(root, identity_id, source_name)
    except TimeoutError:
        return


def _release_locked(root: Path, identity_id: str, source_name: Optional[str]) -> None:
    candidates: List[Dict[str, Any]] = []
    if source_name:
        state = _load_core_state(root, source_name)
        if state is not None:
            candidates.append(state)
    else:
        for path in _cores_dir(root).glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                candidates.append(data)

    for state in candidates:
        source = str(state.get("source") or "")
        entries = state.get("identities") or {}
        if identity_id not in entries:
            continue
        entries.pop(identity_id, None)
        for key in list(entries):
            if not _pid_alive(int(entries[key].get("owner") or 0)):
                entries.pop(key)
        if not entries:
            if _core_alive(state):
                stop_mihomo(int(state.get("pid") or 0))
            if source:
                _delete_core_state(root, source)
            return
        try:
            config = load_source(root, source)
        except (OSError, ValueError):
            return  # subscription gone: keep the remaining listeners as-is
        if _apply_core_config(root, source, state, config, entries):
            state["identities"] = entries
            _save_core_state(root, source, state)
        return


def stop_mihomo(pid: Optional[int]) -> None:
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True, text=True, timeout=15,
            )
        else:
            os.kill(int(pid), 15)
    except Exception:  # noqa: BLE001 -- best-effort cleanup
        pass
