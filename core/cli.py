"""ShadowFox backend CLI: identity + browser process orchestration.

The GUI calls these commands and parses their JSON stdout. `launch` spawns a
DETACHED helper process (`_run`) that owns the Camoufox persistent context for
as long as the browser window lives; the CLI call itself returns at once.

Commands:
  list                          identities + runtime state
  create NAME [--os X] [--country Y] [--network direct|proxy]
  delete ID [--purge-profile]  refuse while running
  cookies ID --output FILE     export cookies as JSON (works while running)
  launch ID [--no-wait]         refuse if already running
  stop ID                       kill the process tree, clear runtime.json
  status                        all running instances
  _run ID                       internal: detached browser holder (not for users)

All output is JSON on stdout (one object per line for lists). Exit code 0 on
success, 1 on error (message in {"error": ...}).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from .fsutil import write_text_atomic
from .identity import Identity, create_identity, next_sort_order
from .launcher import build_launch_options
from .extensions import (
    import_local as import_extension,
    install_from_amo,
    list_extensions,
    remove_extension,
    search_extensions,
)
from .proxy import (
    acquire_mihomo,
    data_root as proxy_data_root,
    delete_source,
    detect_core,
    discover_clash_configs,
    import_subscription,
    list_sources,
    load_source,
    node_list,
    release_mihomo,
    rename_source,
    save_settings,
)

DEFAULT_PROFILES_DIR = Path("data") / "profiles"


@contextmanager
def _mutation_lock(profiles_dir: Path):
    """Serialize mutating commands across processes.

    The GUI now dispatches several commands concurrently, so two writes could
    otherwise interleave (e.g. create + reorder). Reads never take this lock.
    """
    data_root = Path(profiles_dir).expanduser().resolve().parent
    data_root.mkdir(parents=True, exist_ok=True)
    path = data_root / ".shadowfox.lock"
    handle = open(path, "a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            deadline = time.time() + 60
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.time() >= deadline:
                        raise ValueError("另一个操作正在进行，请稍后重试")
                    time.sleep(0.2)
        yield
    finally:
        if locked:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def migrate_legacy_profiles(profiles_dir: Path) -> None:
    """Move the legacy <root>/profiles list into the unified data root.

    The GUI has always read <root>/data/profiles while the VBS launcher and
    the CLI defaulted to <root>/profiles, so one machine could hold two
    separate identity lists (and the GUI looked empty). This runs before every
    command and becomes a cheap no-op once the move happened.
    """
    target = profiles_dir.expanduser().resolve()
    if target.is_dir():
        for child in target.iterdir():
            if (child / "identity.json").is_file():
                return
    legacy = target.parent.parent / "profiles"
    if target.parent.name != "data" or legacy.resolve() == target or not legacy.is_dir():
        return
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for child in sorted(legacy.iterdir()):
        if not child.is_dir():
            continue
        destination = target / child.name
        if destination.exists():
            continue
        try:
            shutil.move(str(child), str(destination))
            moved += 1
        except OSError:
            continue
    if moved:
        try:
            legacy.rmdir()
        except OSError:
            pass


# ------------------------------------------------------------- runtime io


def _runtime_path(profiles_dir: Path, identity_id: str) -> Path:
    return profiles_dir / identity_id / "runtime.json"


def _process_snapshot() -> Optional[Set[int]]:
    """All live PIDs in ONE tasklist call.

    `list` used to run tasklist once per identity; with a few environments
    that was several processes every polling tick. One snapshot answers every
    liveness check for the whole command.
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    # A failed or empty tasklist run must not look like "no processes exist":
    # every live identity would be pruned in one tick, releasing the proxy
    # listener under an open browser and leaving every page hanging.
    if out.returncode != 0:
        return None
    pids: Set[int] = set()
    for line in out.stdout.splitlines():
        row = next(csv.reader([line]), [])
        if len(row) >= 2 and row[1].strip().isdigit():
            pids.add(int(row[1]))
    return pids or None


def _process_start_time(pid: int) -> Optional[int]:
    """Creation timestamp of a live process (Windows), or None if unknown.

    Used to distinguish "our helper is still running" from "the OS reused that
    PID for an unrelated process", which a bare pid check cannot do.
    """
    if os.name != "nt" or pid <= 0:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class FileTime(ctypes.Structure):
            _fields_ = [
                ("dwLowDateTime", wintypes.DWORD),
                ("dwHighDateTime", wintypes.DWORD),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            created = FileTime()
            exited = FileTime()
            kernel = FileTime()
            user = FileTime()
            ok = kernel32.GetProcessTimes(
                handle, ctypes.byref(created), ctypes.byref(exited),
                ctypes.byref(kernel), ctypes.byref(user),
            )
            if not ok:
                return None
            return (created.dwHighDateTime << 32) | created.dwLowDateTime
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


def _pid_alive(pid: int, snapshot: Optional[Set[int]] = None) -> bool:
    if pid <= 0:
        return False
    alive = snapshot if snapshot is not None else _process_snapshot()
    if alive is not None:
        return pid in alive
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            # Cannot verify liveness: assume alive. Declaring a live helper
            # dead releases its proxy listener and hangs its browser.
            return True
        return str(pid) in out.stdout
    except Exception:
        return True


def _release_proxy(profiles_dir: Path, identity_id: str, state: Optional[Dict[str, Any]]) -> None:
    """Drop this identity's shared-core listener (best effort)."""
    try:
        release_mihomo(profiles_dir, identity_id, (state or {}).get("mihomo_source"))
    except Exception:
        pass


def runtime_state(
        profiles_dir: Path,
        identity_id: str,
        snapshot: Optional[Set[int]] = None,
) -> Optional[Dict[str, Any]]:
    """The running-instance record, or None. Stale files (dead pid) are pruned."""
    path = _runtime_path(profiles_dir, identity_id)
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        path.unlink()
        return None
    if not _pid_alive(int(state.get("pid") or 0), snapshot):
        # The browser helper died without reaping its proxy listener.
        _release_proxy(profiles_dir, identity_id, state)
        path.unlink()
        return None
    # PIDs get reused by the OS: a live pid alone cannot prove the helper is
    # still ours. Compare the process creation time captured when it started.
    created = state.get("created")
    if created:
        actual = _process_start_time(int(state.get("pid") or 0))
        if actual is not None and actual != int(created):
            _release_proxy(profiles_dir, identity_id, state)
            path.unlink()
            return None
    return state


def _write_runtime(profiles_dir: Path, identity_id: str, state: Dict[str, Any]) -> None:
    path = _runtime_path(profiles_dir, identity_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text_atomic(path, json.dumps(state, indent=2))


HISTORY_FILE = "history.jsonl"
_HISTORY_LIMIT = 500


def _history_path(root: Path) -> Path:
    return Path(root) / HISTORY_FILE


def append_history(root: Path, record: Dict[str, Any]) -> None:
    """Append one launch/stop event. The file is capped so it stays cheap."""
    path = _history_path(root)
    lines: List[str] = []
    if path.is_file():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
    lines.append(json.dumps(record, ensure_ascii=False))
    try:
        write_text_atomic(path, "\n".join(lines[-_HISTORY_LIMIT:]) + "\n")
    except OSError:
        pass


def _network_label(ident: Identity) -> str:
    if ident.network_mode != "proxy":
        return "直连"
    return ident.proxy_node or ident.proxy_server or "代理"


def record_history(profiles_dir: Path, identity_id: str, event: str) -> None:
    try:
        ident = Identity.load(Path(profiles_dir) / identity_id / "identity.json")
    except Exception:
        return
    append_history(proxy_data_root(profiles_dir), {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "event": event,
        "id": ident.id,
        "name": ident.name,
        "network": _network_label(ident),
    })


def _process_children() -> Dict[int, List[int]]:
    """Parent -> children map from one Toolhelp snapshot (no child processes)."""
    children: Dict[int, List[int]] = {}
    if os.name != "nt":
        return children
    try:
        import ctypes
        from ctypes import wintypes

        class ProcessEntry32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        TH32CS_SNAPPROCESS = 0x00000002
        invalid = ctypes.c_void_p(-1).value
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.Process32First.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
        kernel32.Process32Next.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not snapshot or snapshot == invalid:
            return children
        entry = ProcessEntry32()
        entry.dwSize = ctypes.sizeof(ProcessEntry32)
        try:
            ok = kernel32.Process32First(snapshot, ctypes.byref(entry))
            while ok:
                children.setdefault(
                    int(entry.th32ParentProcessID), []
                ).append(int(entry.th32ProcessID))
                ok = kernel32.Process32Next(snapshot, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snapshot)
    except Exception:
        return {}
    return children


def _kill_tree(pid: int, exclude: Optional[Set[int]] = None) -> bool:
    """Kill this process and its descendants, sparing `exclude`.

    A plain `taskkill /T` is wrong now: the subscription proxy core is started
    by whichever helper needed it first, so it sits in that helper's tree while
    serving every identity. Killing the tree blindly would drop the proxy for
    all other running environments.
    """
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 15)
            return True
        except OSError:
            return False
    skip = {int(value) for value in (exclude or set()) if int(value) > 0}
    children = _process_children()
    if not children:
        # Snapshot unavailable: only the plain tree kill is deterministic.
        args = ["taskkill", "/F", "/T", "/PID", str(pid)]
        return subprocess.run(args, capture_output=True, text=True).returncode == 0
    targets: List[int] = []
    queue = [pid]
    while queue:
        current = queue.pop()
        if current in skip:
            continue
        targets.append(current)
        queue.extend(children.get(current, []))
    if not targets:
        return False
    args = ["taskkill", "/F"]
    for target in targets:
        args.extend(["/PID", str(target)])
    return subprocess.run(args, capture_output=True, text=True).returncode == 0


def _profile_browser_pids(profile_dir: Path) -> List[int]:
    """PIDs of browser processes still attached to this profile (Windows)."""
    if os.name != "nt" or not profile_dir.is_dir():
        return []
    # Pass the profile path through the environment: with `-Command`, anything
    # after the script string is parsed as extra PowerShell commands, so
    # `$args[0]` never receives it and the whole query fails.
    script = (
        "Get-CimInstance Win32_Process -Filter \"Name='camoufox.exe'\" | "
        "Where-Object { $_.CommandLine -and "
        "($_.CommandLine.IndexOf($env:CACER_PROFILE_MATCH, "
        "[System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | "
        "ForEach-Object { $_.ProcessId }"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=20,
            env={**os.environ, "CACER_PROFILE_MATCH": str(profile_dir)},
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pids: List[int] = []
    for line in result.stdout.splitlines():
        value = line.strip()
        if value.isdigit():
            pids.append(int(value))
    return pids


def _reap_orphan_browsers(profiles_dir: Path, identity_id: str) -> None:
    """Close windows left behind by a dead helper.

    Such a window still points at the proxy port of the instance that owned
    it. Once that helper is gone the listener is gone too, so every page hangs
    forever. Reap those processes before a fresh helper takes over the profile.
    """
    for pid in _profile_browser_pids(Path(profiles_dir) / identity_id / "profile"):
        _kill_tree(pid, set())


def _tail_log(path: Path, lines: int = 12) -> str:
    """Return a short, user-facing tail without flooding CLI JSON output."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        return "\\n".join(text.splitlines()[-lines:]).strip()
    except OSError:
        return ""


# ---------------------------------------------------------------- commands


def _identity_summary(ident: Identity, running: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "id": ident.id,
        "status": (running or {}).get("status", "stopped"),
        "name": ident.name,
        "note": ident.note,
        "os": ident.engine_os,
        "country": ident.geo.country,
        "locale": ident.geo.locale,
        "timezone": ident.geo.timezone,
        "languages": ident.geo.languages,
        "created_at": ident.created_at,
        "network_mode": ident.network_mode,
        "proxy_server": ident.proxy_server,
        "proxy_source": ident.proxy_source,
        "proxy_node": ident.proxy_node,
        "ui_locale": ident.launcher.ui_locale,
        "memory_cache": ident.launcher.memory_cache,
        "disabled_extensions": ident.disabled_extensions,
        "running": bool(running),
        "pid": running.get("pid") if running else None,
    }


def _load_identities(profiles_dir: Path) -> List[Identity]:
    out = []
    if not profiles_dir.exists():
        return out
    for d in sorted(profiles_dir.iterdir()):
        f = d / "identity.json"
        if not f.is_file():
            continue
        try:
            out.append(Identity.load(f))
        except (OSError, ValueError, KeyError, TypeError):
            # A damaged/half-written identity must not take the whole list
            # down (the GUI would show no environments at all).
            continue
    # Drag-and-drop position first; identities created before sorting existed
    # all carry sort_order=0 and keep their historical (creation) order.
    out.sort(key=lambda i: (i.sort_order, i.created_at, i.id))
    return out


def _emit(payload: Any) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _fail(message: str) -> int:
    print(json.dumps({"error": message}, ensure_ascii=False))
    return 1


def cmd_list(args):
    profiles_dir = Path(args.profiles)
    snapshot = _process_snapshot()
    result = []
    for ident in _load_identities(profiles_dir):
        result.append(_identity_summary(
            ident, runtime_state(profiles_dir, ident.id, snapshot)))
    return _emit(result)


def cmd_create(args):
    ident = create_identity(
        args.name, os=args.os, country=args.country,
        profiles_dir=Path(args.profiles), max_draws=args.max_draws,
        network_mode=args.network, proxy_server=args.proxy_server or None,
        proxy_source=args.proxy_source or None,
        proxy_node=args.proxy_node or None,
        note=args.note or "",
        ui_locale=args.ui_locale,
        memory_cache=args.memory_cache,
        persist=False,
    )
    with _mutation_lock(Path(args.profiles)):
        ident.sort_order = next_sort_order(Path(args.profiles))
        ident.save(Path(args.profiles))
    return _emit(_identity_summary(ident, None))


def cmd_clone(args):
    profiles_dir = Path(args.profiles)
    if runtime_state(profiles_dir, args.id):
        return _fail("环境正在运行中，请先停止后再复制")
    source_file = profiles_dir / args.id / "identity.json"
    if not source_file.is_file():
        return _fail(f"找不到环境：{args.id}")
    source = Identity.load(source_file)
    clone = create_identity(
        args.name,
        os=source.engine_os,
        country=source.geo.country,
        profiles_dir=profiles_dir,
        network_mode=source.network_mode,
        proxy_server=source.proxy_server,
        proxy_source=source.proxy_source,
        proxy_node=source.proxy_node,
        note=source.note,
        ui_locale=source.launcher.ui_locale or "",
        memory_cache=source.launcher.memory_cache,
        persist=False,
    )
    with _mutation_lock(profiles_dir):
        clone.sort_order = next_sort_order(profiles_dir)
        clone.save(profiles_dir)
    return _emit(_identity_summary(clone, None))


def cmd_export(args):
    profiles_dir = Path(args.profiles)
    if runtime_state(profiles_dir, args.id):
        return _fail("环境正在运行中，请先停止后再导出")
    source = profiles_dir / args.id
    identity_file = source / "identity.json"
    if not identity_file.is_file():
        return _fail(f"找不到环境：{args.id}")
    destination = Path(args.archive).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(identity_file, "identity.json")
        profile = source / "profile"
        if profile.is_dir():
            for file in profile.rglob("*"):
                if not file.is_file():
                    continue
                relative = file.relative_to(profile)
                if relative.parts and relative.parts[0] == "extensions":
                    # Add-on mirrors are re-synced from <data>/extensions on
                    # the next launch; packing them per identity was a large
                    # share of the archive for no benefit.
                    continue
                if any(part in _SKIP_DIRS for part in relative.parts):
                    continue
                if file.name in _SKIP_FILES:
                    continue
                archive.write(file, Path("profile") / relative)
    return _emit({"archive": str(destination), "id": args.id})


# Volatile files never belong in a migration archive: runtime.json would make
# the imported copy look "running", and engine caches / telemetry / session
# backups are rebuilt on demand.
_SKIP_DIRS = {
    "cache", "cache2", "startupCache", "shader-cache", "crashes",
    "sessionstore-backups", "datareporting", "minidumps",
    "saved-telemetry-pings",
}
_SKIP_FILES = {"runtime.json", "helper.log", "parent.lock", "lock", ".parentlock"}


def _running_ids(profiles_dir: Path) -> List[str]:
    """Probe runtime.json files directly so a damaged identity cannot block
    the whole export/import (and stale states are pruned on the way)."""
    root = Path(profiles_dir)
    if not root.is_dir():
        return []
    snapshot = _process_snapshot()
    return [child.name for child in root.iterdir()
            if (child / "runtime.json").is_file()
            and runtime_state(root, child.name, snapshot)]


def _archive_path(raw: str) -> Path:
    """Absolute paths are used as-is; a bare name lands in Downloads."""
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    downloads = Path.home() / "Downloads"
    return (downloads if downloads.is_dir() else Path.home()) / path


# Only user-owned state is portable. Debug leftovers (browser dumps, arti
# logs, screenshots), mihomo caches and rebuild backups used to ride along
# with `export-all`, doubling archive size and leaking local debug data.
_EXPORT_DIRS = ("profiles", "subscriptions", "extensions")
_EXPORT_FILES = ("settings.json", "history.jsonl")


def cmd_export_all(args):
    """Zip the portable part of the data root: environments, subscriptions,
    the extension repository, settings and launch history."""
    profiles_dir = Path(args.profiles)
    if _running_ids(profiles_dir):
        print(json.dumps({"error": "请先停止所有正在运行的浏览器，再导出全部数据"}, ensure_ascii=False))
        return 1
    root = proxy_data_root(profiles_dir)
    destination = _archive_path(args.archive).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for directory in _EXPORT_DIRS:
            base = root / directory
            if not base.is_dir():
                continue
            for path in base.rglob("*"):
                if not path.is_file():
                    continue
                relative = path.relative_to(root)
                if relative.name in _SKIP_FILES:
                    continue
                if any(part in _SKIP_DIRS for part in relative.parts):
                    continue
                parts = relative.parts
                if (len(parts) > 4 and parts[0] == "profiles"
                        and parts[2] == "profile" and parts[3] == "extensions"):
                    # Per-identity add-on mirrors; re-synced at launch.
                    continue
                if path.resolve() == destination:
                    continue
                archive.write(path, relative)
                count += 1
        for name in _EXPORT_FILES:
            path = root / name
            if path.is_file():
                archive.write(path, name)
                count += 1
    print(json.dumps({"archive": str(destination), "files": count}, ensure_ascii=False))
    return 0


def cmd_import_all(args):
    """Validate and stage a full archive, then restore with rollback on failure."""
    profiles_dir = Path(args.profiles)
    if _running_ids(profiles_dir):
        raise ValueError("请先停止所有正在运行的浏览器，再导入数据")
    source = _archive_path(args.archive)
    if not source.is_file():
        raise ValueError(f"找不到数据包：{source}")
    root = proxy_data_root(profiles_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".shadowfox-restore-", dir=root.parent))
    staged, backups = work / "staged", work / "backups"
    entries = []
    applied = []
    created_dirs = []
    keep_backup = False
    try:
        with zipfile.ZipFile(source) as archive:
            seen = set()
            for member in archive.infolist():
                name = member.filename.replace("\\", "/").rstrip("/")
                parts = name.split("/")
                if (not name or any(
                        p in ("", ".", "..") or ":" in p or p != p.rstrip(" .")
                        for p in parts)
                        or (member.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ValueError(f"数据包包含非法路径：{member.filename}")
                target = root.joinpath(*parts).resolve()
                if root not in target.parents:
                    raise ValueError(f"数据包包含非法路径：{member.filename}")
                # Match export-all's data whitelist; never restore locks or
                # proxy runtime/control files supplied by an archive.
                if parts[0] not in ("profiles", "subscriptions", "extensions"):
                    if len(parts) != 1 or name not in ("settings.json", "history.jsonl"):
                        raise ValueError(f"数据包包含不支持的文件：{member.filename}")
                if member.is_dir() or parts[-1] in _SKIP_FILES:
                    continue
                key = str(target).casefold()
                if key in seen:
                    raise ValueError(f"数据包包含重复路径：{member.filename}")
                seen.add(key)
                relative = target.relative_to(root)
                prepared = staged / relative
                prepared.parent.mkdir(parents=True, exist_ok=True)
                # Reading to EOF also verifies ZIP CRC before any live write.
                with archive.open(member) as src, open(prepared, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                entries.append((relative, target, prepared))
        # Back up every existing destination before the first replacement.
        for relative, target, _ in entries:
            if target.exists():
                if not target.is_file():
                    raise ValueError(f"恢复目标不是文件：{target}")
                backup = backups / relative
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
        try:
            for relative, target, prepared in entries:
                missing = []
                parent = target.parent
                while not parent.exists():
                    missing.append(parent)
                    parent = parent.parent
                for directory in reversed(missing):
                    directory.mkdir()
                    created_dirs.append(directory)
                os.replace(prepared, target)
                applied.append((relative, target))
        except BaseException as exc:
            failures = []
            for relative, target in reversed(applied):
                try:
                    backup = backups / relative
                    if backup.is_file():
                        os.replace(backup, target)
                    else:
                        target.unlink()
                except OSError as rollback_error:
                    failures.append(str(rollback_error))
            for directory in reversed(created_dirs):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            if failures:
                keep_backup = True
                raise RuntimeError(f"恢复失败，部分文件无法回滚；原文件备份保留在 {backups}") from exc
            raise
    finally:
        if not keep_backup:
            shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({"archive": str(source), "files": len(entries), "data": str(root)}, ensure_ascii=False))
    return 0


def cmd_cookies(args):
    """Dump this identity's cookies as Playwright-compatible JSON.

    Works while the browser is running: the database (plus its WAL) is copied
    to a temp directory first, so SQLite never hands us a half-written page
    and we never block on the live file.
    """
    profiles_dir = Path(args.profiles)
    database = profiles_dir / args.id / "profile" / "cookies.sqlite"
    if not database.is_file():
        return _fail("该环境暂无 Cookie 记录（请先启动浏览器访问网站）")
    destination = Path(args.output).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    same_site = {0: "None", 1: "Lax", 2: "Strict"}
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "cookies.sqlite"
        shutil.copy2(database, copy)
        for suffix in ("-wal", "-shm"):
            extra = database.with_name(database.name + suffix)
            if extra.is_file():
                shutil.copy2(extra, copy.with_name(copy.name + suffix))
        connection = sqlite3.connect(copy)
        try:
            rows = connection.execute(
                "SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite"
                " FROM moz_cookies"
            ).fetchall()
        finally:
            connection.close()
    cookies = [
        {
            "name": name,
            "value": value,
            "domain": host,
            "path": path,
            "expires": expiry if expiry else -1,
            "httpOnly": bool(http_only),
            "secure": bool(secure),
            "sameSite": same_site.get(site, "Lax"),
        }
        for name, value, host, path, expiry, secure, http_only, site in rows
    ]
    destination.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    return _emit({"archive": str(destination), "id": args.id, "count": len(cookies)})


def cmd_import(args):
    profiles_dir = Path(args.profiles)
    archive_path = Path(args.archive).expanduser()
    if not archive_path.is_file():
        return _fail(f"找不到身份包：{archive_path}")
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        if "identity.json" not in names:
            return _fail("无效的身份包：缺少 identity.json")
        for name in names:
            if name.startswith("/") or ".." in Path(name).parts:
                return _fail("身份包包含非法路径")
        imported = Identity.from_dict(json.loads(archive.read("identity.json")))
        target_id = imported.id
        if (profiles_dir / target_id / "identity.json").exists():
            target_id = uuid.uuid4().hex[:12]
            imported.id = target_id
        # Append the imported environment to the end of the current ordering.
        imported.sort_order = next_sort_order(profiles_dir)
        target = profiles_dir / target_id
        target.mkdir(parents=True, exist_ok=False)
        write_text_atomic(
            target / "identity.json",
            json.dumps(imported.to_dict(), ensure_ascii=False, indent=2),
        )
        for name in names:
            if name.startswith("profile/") and not name.endswith("/"):
                out = target / name
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(archive.read(name))
    return _emit(_identity_summary(imported, None))


def cmd_rebuild(args):
    profiles_dir = Path(args.profiles)
    if runtime_state(profiles_dir, args.id):
        raise ValueError("identity is running; stop it first")
    target = profiles_dir / args.id
    source_file = target / "identity.json"
    original = source_file.read_bytes()
    source = Identity.from_dict(json.loads(original))
    # Generate without publishing a temporary environment or holding the lock.
    rebuilt = create_identity(
        source.name,
        os=args.os or source.engine_os,
        country=args.country or source.geo.country,
        profiles_dir=profiles_dir,
        max_draws=args.max_draws,
        network_mode=source.network_mode,
        proxy_server=source.proxy_server,
        proxy_source=source.proxy_source,
        proxy_node=source.proxy_node,
        note=source.note,
        ui_locale=source.launcher.ui_locale or "",
        memory_cache=source.launcher.memory_cache,
        sort_order=source.sort_order,
        persist=False,
    )
    with _mutation_lock(profiles_dir):
        if runtime_state(profiles_dir, args.id):
            raise ValueError("identity is running; stop it first")
        if not source_file.is_file() or source_file.read_bytes() != original:
            raise ValueError("环境在生成指纹期间已变更，请重新打开后重试")
        backups = profiles_dir.parent / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / f"{args.id}-{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
        shutil.move(str(target), str(backup))
        try:
            rebuilt.id = source.id
            rebuilt.save(profiles_dir)
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            shutil.move(str(backup), str(target))
            raise
        _prune_backups(backups, args.id)
    print(json.dumps(_identity_summary(rebuilt, None), ensure_ascii=False))
    return 0


def _prune_backups(backups: Path, identity_id: str, keep: int = 3) -> None:
    """Keep only the newest N rebuild snapshots of one identity.

    Every rebuild wrote a full copy and nothing ever deleted them, so the
    folder (and every subsequent whole-data export) grew without bound.
    """
    try:
        items = [
            path for path in backups.iterdir()
            if path.is_dir() and path.name.startswith(f"{identity_id}-")
        ]
        items.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return
    for stale in items[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def cmd_delete(args):
    profiles_dir = Path(args.profiles)
    if runtime_state(profiles_dir, args.id):
        return _fail("环境正在运行中，请先停止后再删除")
    d = profiles_dir / args.id
    if not (d / "identity.json").is_file():
        return _fail(f"找不到环境：{args.id}")
    if args.purge_profile:
        shutil.rmtree(d)
        # Rebuild snapshots are keyed by identity id; leaving them behind would
        # silently keep a full profile copy of a deleted identity forever.
        backups = proxy_data_root(profiles_dir) / "backups"
        if backups.is_dir():
            for stale in backups.glob(f"{args.id}-*"):
                shutil.rmtree(stale, ignore_errors=True)
        return _emit({"deleted": args.id, "purged": True})
    else:
        (d / "identity.json").unlink()
        return _emit({"deleted": args.id, "purged": False})


def cmd_edit(args):
    profiles_dir = Path(args.profiles)
    ident_file = profiles_dir / args.id / "identity.json"
    if not ident_file.is_file():
        return _fail(f"找不到环境：{args.id}")
    if runtime_state(profiles_dir, args.id) and any((
        args.network is not None,
        args.proxy_server is not None,
        args.proxy_source is not None,
        args.proxy_node is not None,
        args.clear_proxy,
    )):
        return _fail("浏览器运行中只能修改名称、备注、界面语言、内存缓存和扩展开关；网络与代理设置请先停止浏览器")
    ident = Identity.load(ident_file)
    ident.update_meta(
        name=args.name, note=args.note, network_mode=args.network,
        proxy_server=args.proxy_server,
        proxy_source=args.proxy_source,
        proxy_node=args.proxy_node,
        clear_proxy=args.clear_proxy,
        ui_locale=args.ui_locale,
        memory_cache=args.memory_cache,
        disabled_extensions=(
            [slug.strip() for slug in (args.disabled_extensions or "").split(",") if slug.strip()]
            if args.disabled_extensions is not None else None
        ),
        profiles_dir=profiles_dir,
    )
    return _emit(_identity_summary(ident, None))


def cmd_reorder(args):
    """Persist a GUI drag-and-drop ordering (safe while browsers run)."""
    profiles_dir = Path(args.profiles)
    requested = [x.strip() for x in (args.ids or "").split(",") if x.strip()]
    if not requested:
        return _fail("排序列表不能为空")
    existing = _load_identities(profiles_dir)
    by_id = {ident.id: ident for ident in existing}
    requested = list(dict.fromkeys(requested))
    unknown = [ident_id for ident_id in requested if ident_id not in by_id]
    if unknown:
        return _fail(f"找不到环境：{unknown[0]}")
    # Any identity the caller did not mention keeps its relative position after
    # the explicitly ordered ones.
    ordered = requested + [ident.id for ident in existing if ident.id not in requested]
    for index, ident_id in enumerate(ordered):
        ident = by_id[ident_id]
        if ident.sort_order != index:
            ident.sort_order = index
            ident.save(profiles_dir)
    return _emit({"order": ordered})


def cmd_font_requirements(args):
    """Resolve the engine's final font draw without starting a browser."""
    if not args.id or not all(char.isascii() and (char.isalnum() or char in "-_") for char in args.id):
        raise ValueError("无效环境 ID")
    identity = Identity.load(Path(args.profiles) / args.id / "identity.json")
    from .launcher import required_font_families
    return _emit({"fonts": required_font_families(identity),
                  "country": identity.geo.country,
                  "languages": identity.geo.languages,
                  "locale": identity.geo.locale,
                  "ui_locale": identity.launcher.ui_locale})


def cmd_launch(args):
    profiles_dir = Path(args.profiles).resolve()
    if runtime_state(profiles_dir, args.id):
        return _fail("该环境已在运行中")
    ident_file = profiles_dir / args.id / "identity.json"
    if not ident_file.is_file():
        return _fail(f"找不到环境：{args.id}")

    _reap_orphan_browsers(profiles_dir, args.id)

    # Detached helper owns the browser; overwrite helper.log on each fresh
    # launch so logs stay bounded and parent does not leak the handle.
    log_path = profiles_dir / args.id / "helper.log"
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    helper_python = sys.executable
    if os.name == "nt":
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        if pythonw.is_file():
            helper_python = str(pythonw)
    with open(log_path, "wb") as log_file:
        proc = subprocess.Popen(
            [helper_python, str(Path(__file__).with_name("bootstrap.py")),
             "--profiles", str(profiles_dir),
             "_run", args.id],
            creationflags=creationflags,
            cwd=str(Path(__file__).resolve().parent.parent),
            env=env,
            stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )

    # Wait for the helper to either publish runtime.json or die.
    deadline = time.time() + 60
    while time.time() < deadline:
        state = runtime_state(profiles_dir, args.id, _process_snapshot())
        if proc.poll() is not None:
            detail = _tail_log(log_path)
            message = "浏览器启动失败"
            if detail:
                message += f"：{detail[-1200:]}"
            return _fail(message)
        if state and args.no_wait:
            record_history(profiles_dir, args.id, "launch")
            return _emit(state)
        if state and state.get("status") == "running":
            record_history(profiles_dir, args.id, "launch")
            return _emit(state)
        time.sleep(0.5)
    detail = _tail_log(log_path)
    message = "浏览器启动超时（60 秒）"
    if detail:
        message += f"：{detail[-1200:]}"
    return _fail(message)


def _stop_one(profiles_dir: Path, identity_id: str, state: Dict[str, Any]) -> Dict[str, Any]:
    pid = int(state["pid"])
    ok = _kill_tree(pid, {int(state.get("mihomo_pid") or 0)})
    for _ in range(20):
        if not _pid_alive(pid):
            break
        time.sleep(0.25)
    _release_proxy(profiles_dir, identity_id, state)
    path = _runtime_path(profiles_dir, identity_id)
    if path.exists():
        path.unlink()
    record_history(profiles_dir, identity_id, "stop")
    return {"stopped": identity_id, "pid": pid, "killed": ok}


def cmd_stop(args):
    profiles_dir = Path(args.profiles)
    state = runtime_state(profiles_dir, args.id)
    if not state:
        return _fail("该环境当前未在运行")
    return _emit(_stop_one(profiles_dir, args.id, state))


def cmd_stop_all(args):
    profiles_dir = Path(args.profiles)
    snapshot = _process_snapshot()
    stopped = []
    for identity_id in _running_ids(profiles_dir):
        state = runtime_state(profiles_dir, identity_id, snapshot)
        if state:
            stopped.append(_stop_one(profiles_dir, identity_id, state))
    return _emit({"stopped": stopped, "count": len(stopped)})


def cmd_status(args):
    profiles_dir = Path(args.profiles)
    snapshot = _process_snapshot()
    running = []
    for ident in _load_identities(profiles_dir):
        state = runtime_state(profiles_dir, ident.id, snapshot)
        if state:
            running.append(_identity_summary(ident, state))
    print(json.dumps(running, ensure_ascii=False))
    return 0


def cmd_history(args):
    root = proxy_data_root(Path(args.profiles))
    items: List[Dict[str, Any]] = []
    path = _history_path(root)
    if path.is_file():
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.strip():
                    continue
                try:
                    items.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            items = []
    items.reverse()
    print(json.dumps({"items": items[: max(1, int(args.limit))]}, ensure_ascii=False))
    return 0


# ------------------------------------------------------------ _run helper


def _run_state(ident, status, mihomo=None, proxy_server=None):
    state = {
        "pid": os.getpid(),
        "network_mode": ident.network_mode,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "name": ident.name,
        "status": status,
    }
    created = _process_start_time(os.getpid())
    if created is not None:
        state["created"] = created
    if ident.proxy_source:
        state["proxy_source"] = ident.proxy_source
    if ident.proxy_node:
        state["proxy_node"] = ident.proxy_node
    if mihomo is not None:
        state["mihomo_pid"] = mihomo.pid
        state["mihomo_port"] = mihomo.port
        if mihomo.source:
            state["mihomo_source"] = mihomo.source
    if proxy_server:
        state["proxy_server"] = proxy_server
    return state


def cmd_run(args):
    """Internal: detached process that owns the browser until the window closes."""
    profiles_dir = Path(args.profiles)
    ident = Identity.load(profiles_dir / args.id / "identity.json")

    # Subscription routing: attach to the subscription's shared mihomo core,
    # which gives this identity its own listener port. Manual proxy_server
    # keeps its existing behaviour.
    mihomo = None
    proxy_override = None
    if ident.network_mode == "proxy" and ident.proxy_source and ident.proxy_node:
        mihomo = acquire_mihomo(
            profiles_dir, args.id, ident.proxy_source, ident.proxy_node
        )
        proxy_override = f"socks5://127.0.0.1:{mihomo.port}"

    published = False
    try:
        opts = build_launch_options(
            ident, profiles_dir=profiles_dir,
            proxy_override=proxy_override,
            marker_label=ident.proxy_node if mihomo else None,
        )

        from camoufox.sync_api import Camoufox

        _write_runtime(
            profiles_dir, args.id,
            _run_state(ident, "starting", mihomo, proxy_override),
        )
        with Camoufox(**opts) as browser:
            # Only publish running after the browser context exists. This
            # prevents the GUI from claiming success during a slow/crashed
            # engine initialization.
            published = True
            _write_runtime(
                profiles_dir, args.id,
                _run_state(ident, "running", mihomo, proxy_override),
            )
            # The persistent context already opens one page of its own;
            # reusing it instead of new_page() avoids double windows.
            page = browser.pages[0] if browser.pages else browser.new_page()
            # Give the native window/tab a clear operator-facing identity.
            # Websites may replace the document title after navigation, so the
            # toolbar marker in launcher.USERCHROME_CSS remains the persistent
            # visual indicator.
            title = f"Cacer · {ident.name}"
            if mihomo and ident.proxy_node:
                title += f" · {ident.proxy_node}"
            else:
                title += " · 指纹环境隔离中"
            try:
                page.evaluate("document.title = " + json.dumps(title))
            except Exception:
                pass
            try:
                # Camoufox returns a BrowserContext here, not Browser. Watch
                # the underlying browser connection; calling is_connected()
                # directly on the context raises and would close the window.
                engine = getattr(browser, "browser", None)
                if engine is not None:
                    while engine.is_connected():
                        # Keep servicing the Playwright connection. An idle
                        # client keeps queueing protocol events (console
                        # messages from script-heavy pages such as Google's
                        # sign-in flow) until the pipe fills and the browser's
                        # main thread blocks: typing, navigation and even the
                        # window's remote commands all hang. A client-side
                        # wait drains those events without touching the page.
                        try:
                            live = [p for p in browser.pages if not p.is_closed()]
                        except Exception:
                            live = []
                        if live:
                            try:
                                live[0].wait_for_timeout(250)
                            except Exception:
                                time.sleep(0.5)
                        else:
                            time.sleep(0.5)
                else:
                    # Fallback for engines that do not expose context.browser.
                    # The startup page may be replaced, so inspect all pages.
                    empty_since = None
                    while True:
                        pages = [p for p in browser.pages if not p.is_closed()]
                        if pages:
                            empty_since = None
                        else:
                            empty_since = empty_since or time.monotonic()
                            if time.monotonic() - empty_since > 2:
                                break
                        time.sleep(0.5)
            except Exception:
                # Browser process died under us; the context manager reaps.
                pass
    finally:
        # Window closed (or crash): ensure the whole tree goes down even if
        # the sync wrapper failed to reap children.
        if mihomo is not None:
            _release_proxy(profiles_dir, args.id, {"mihomo_source": mihomo.source})
        path = _runtime_path(profiles_dir, args.id)
        if path.exists():
            path.unlink()
        if published:
            record_history(profiles_dir, args.id, "closed")
    return 0


# ------------------------------------------------------------ proxy admin


def cmd_proxy_sources(args):
    root = proxy_data_root(Path(args.profiles))
    print(json.dumps({
        "sources": list_sources(root),
        "core": detect_core(root),
    }, ensure_ascii=False))
    return 0


def cmd_proxy_nodes(args):
    root = proxy_data_root(Path(args.profiles))
    config = load_source(root, args.source)
    print(json.dumps({
        "source": Path(args.source).name,
        "nodes": node_list(config),
    }, ensure_ascii=False))
    return 0


def cmd_proxy_import(args):
    root = proxy_data_root(Path(args.profiles))
    result = import_subscription(
        root, kind=args.kind, value=args.value, name=args.name, label=args.label,
        commit_lock=_mutation_lock(Path(args.profiles)),
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_proxy_rename(args):
    root = proxy_data_root(Path(args.profiles))
    print(json.dumps(rename_source(root, args.source, args.label), ensure_ascii=False))
    return 0


def cmd_proxy_delete(args):
    root = proxy_data_root(Path(args.profiles))
    print(json.dumps(delete_source(root, args.source), ensure_ascii=False))
    return 0


def cmd_proxy_set_core(args):
    root = proxy_data_root(Path(args.profiles))
    path = Path(args.path).expanduser()
    if not path.is_file():
        print(json.dumps({"error": f"文件不存在：{path}"}, ensure_ascii=False))
        return 1
    save_settings(root, {"mihomo_path": str(path)})
    print(json.dumps(detect_core(root), ensure_ascii=False))
    return 0


def cmd_proxy_discover(args):
    print(json.dumps({"configs": discover_clash_configs()}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------- extension center


def cmd_ext_list(args):
    print(json.dumps({
        "extensions": list_extensions(Path(args.profiles)),
    }, ensure_ascii=False))
    return 0


def cmd_ext_search(args):
    try:
        result = search_extensions(Path(args.profiles), args.query, args.limit)
    except Exception as exc:
        print(json.dumps({"error": f"搜索扩展失败：{exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_ext_install(args):
    try:
        entry = install_from_amo(Path(args.profiles), args.slug,
                                 commit_lock=_mutation_lock(Path(args.profiles)))
    except Exception as exc:
        print(json.dumps({"error": f"安装扩展失败：{exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps(entry, ensure_ascii=False))
    return 0


def cmd_ext_import(args):
    try:
        entry = import_extension(Path(args.profiles), args.path,
                                 commit_lock=_mutation_lock(Path(args.profiles)))
    except Exception as exc:
        print(json.dumps({"error": f"导入扩展失败：{exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps(entry, ensure_ascii=False))
    return 0


def cmd_ext_remove(args):
    try:
        result = remove_extension(Path(args.profiles), args.slug)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


# ------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="core.cli")
    ap.add_argument("--profiles", default=str(DEFAULT_PROFILES_DIR))
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list")

    p = sub.add_parser("create")
    p.add_argument("name")
    p.add_argument("--os", default=None, choices=["windows", "macos", "linux"])
    p.add_argument("--country", default=None)
    p.add_argument("--network", default="direct", choices=["proxy", "direct"])
    p.add_argument("--proxy-server", default=None,
                   help="e.g. socks5://127.0.0.1:1080 (required for --network proxy)")
    p.add_argument("--proxy-source", default=None,
                   help="subscription file name under subscriptions/")
    p.add_argument("--proxy-node", default=None,
                   help="node name selected from that subscription")
    p.add_argument("--note", default="")
    p.add_argument("--max-draws", type=int, default=40)
    p.add_argument("--ui-locale", default="zh-CN",
                   help="browser UI language, e.g. zh-CN / en-US; empty string = follow identity")
    p.add_argument("--no-memory-cache", dest="memory_cache", action="store_false",
                   default=True,
                   help="keep the engine's disk-only cache (stock camoufox behaviour)")

    p = sub.add_parser("clone")
    p.add_argument("id")
    p.add_argument("name")

    p = sub.add_parser("export")
    p.add_argument("id")
    p.add_argument("archive")

    p = sub.add_parser("cookies")
    p.add_argument("id")
    p.add_argument("--output", required=True)

    p = sub.add_parser("import")
    p.add_argument("archive")

    p = sub.add_parser("export-all")
    p.add_argument("--archive", required=True,
                   help="zip path; a bare file name is written to Downloads")
    p = sub.add_parser("import-all")
    p.add_argument("--archive", required=True)

    p = sub.add_parser("rebuild")
    p.add_argument("id")
    p.add_argument("--os", default=None, choices=["windows", "macos", "linux"])
    p.add_argument("--country", default=None)
    p.add_argument("--max-draws", type=int, default=80)

    p = sub.add_parser("delete")
    p.add_argument("id")
    p.add_argument("--purge-profile", action="store_true")

    p = sub.add_parser("edit")
    p.add_argument("id")
    p.add_argument("--name", default=None)
    p.add_argument("--note", default=None)
    p.add_argument("--network", default=None, choices=["proxy", "direct"])
    p.add_argument("--proxy-server", default=None)
    p.add_argument("--proxy-source", default=None,
                   help="subscription file name; empty string clears it")
    p.add_argument("--proxy-node", default=None,
                   help="node name; empty string clears it")
    p.add_argument("--clear-proxy", action="store_true",
                   help="clear the stored proxy_server")
    p.add_argument("--ui-locale", default=None,
                   help="browser UI language, e.g. zh-CN / en-US; empty string = follow identity")
    p.add_argument("--memory-cache", dest="memory_cache", action="store_const",
                   const=True, default=None,
                   help="enable the browser memory cache")
    p.add_argument("--no-memory-cache", dest="memory_cache", action="store_const",
                   const=False, help="disable the browser memory cache")
    p.add_argument("--disabled-extensions", default=None,
                   help="comma-separated extension slugs this environment skips; "
                        "empty string enables every installed extension")

    p = sub.add_parser("reorder")
    p.add_argument("--ids", required=True,
                   help="comma-separated identity ids in display order")

    p = sub.add_parser("font-requirements")
    p.add_argument("id")

    p = sub.add_parser("launch")
    p.add_argument("id")
    p.add_argument("--no-wait", action="store_true",
                   help="return after helper initialization; browser continues starting")

    sub.add_parser("stop-all")
    p = sub.add_parser("stop")
    p.add_argument("id")

    sub.add_parser("status")

    p = sub.add_parser("history")
    p.add_argument("--limit", type=int, default=100)

    p = sub.add_parser("proxy-sources")
    p = sub.add_parser("proxy-nodes")
    p.add_argument("--source", required=True)
    p = sub.add_parser("proxy-import")
    p.add_argument("--kind", required=True, choices=["file", "url", "text"])
    p.add_argument("--value", required=True)
    p.add_argument("--name", default=None)
    p.add_argument("--label", default=None)
    p = sub.add_parser("proxy-rename")
    p.add_argument("--source", required=True)
    p.add_argument("--label", default="")
    p = sub.add_parser("proxy-delete")
    p.add_argument("--source", required=True)
    p = sub.add_parser("proxy-set-core")
    p.add_argument("--path", required=True)
    sub.add_parser("proxy-discover")

    p = sub.add_parser("ext-list")
    p = sub.add_parser("ext-search")
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("ext-install")
    p.add_argument("--slug", required=True)
    p = sub.add_parser("ext-import")
    p.add_argument("--path", required=True)
    p = sub.add_parser("ext-remove")
    p.add_argument("--slug", required=True)

    p = sub.add_parser("_run")
    p.add_argument("id")

    args = ap.parse_args(argv)
    migrate_legacy_profiles(Path(args.profiles))
    handlers = {
        "list": cmd_list, "create": cmd_create, "clone": cmd_clone, "export": cmd_export, "cookies": cmd_cookies, "import": cmd_import, "rebuild": cmd_rebuild, "delete": cmd_delete,
        "export-all": cmd_export_all, "import-all": cmd_import_all,
        "edit": cmd_edit, "launch": cmd_launch, "stop": cmd_stop, "stop-all": cmd_stop_all,
        "font-requirements": cmd_font_requirements,
        "reorder": cmd_reorder,
        "status": cmd_status, "_run": cmd_run,
        "history": cmd_history,
        "proxy-sources": cmd_proxy_sources, "proxy-nodes": cmd_proxy_nodes,
        "proxy-import": cmd_proxy_import, "proxy-rename": cmd_proxy_rename,
        "proxy-delete": cmd_proxy_delete,
        "proxy-set-core": cmd_proxy_set_core,
        "proxy-discover": cmd_proxy_discover,
        "ext-list": cmd_ext_list,
        "ext-search": cmd_ext_search,
        "ext-install": cmd_ext_install,
        "ext-import": cmd_ext_import,
        "ext-remove": cmd_ext_remove,
    }
    # Slow preparation runs outside the lock; those handlers acquire it only
    # when committing. Other mutations retain the full-command lock.
    mutating = {
        "delete", "edit", "reorder",
        "launch", "stop", "stop-all", "import", "import-all",
        "proxy-rename", "proxy-delete", "proxy-set-core",
        "ext-remove",
    }
    try:
        if args.cmd in mutating:
            with _mutation_lock(Path(args.profiles)):
                return handlers[args.cmd](args)
        return handlers[args.cmd](args)
    except Exception as e:  # noqa: BLE001 -- CLI boundary
        return _fail(str(e) or type(e).__name__)


if __name__ == "__main__":
    sys.exit(main())
