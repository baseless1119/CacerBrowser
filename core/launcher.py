"""Identity -> Camoufox launch options mapping (fully automatic).

Everything the browser needs is derived from the identity file; the caller
only chooses the SOCKS port (or "direct"). The mapping is deliberately
explicit here so the GUI/CLI layers never touch camoufox internals.
"""

from __future__ import annotations

import json as _json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)


# userChrome.css / engine chrome.css rules: keep the periphery "+" (the one
# built into the tab strip) visible, hide the toolbar-widget copy, and pull
# the unified-extensions (puzzle) button into the right-hand button cluster.
# NOTE: camoufox's engine compiles the userChrome.css loader out (no
# "userChrome.css" string in xul.dll), so the profile file is inert there;
# the engine-injected rules come from ensure_engine_chrome_css(). CSS is
# the one layer the CustomizableUI state machine cannot fight: the puzzle
# button's placement is re-derived at every startup (auto-add wins over the
# pinned state), but a box-ordinal only changes presentation.
USERCHROME_CSS = """\
/* ShadowFox: the new-tab "+" lives at the end of the tab strip */
#tabbrowser-arrowscrollbox-periphery > #tabs-newtab-button {
  display: flex !important;
  visibility: visible !important;
}
#new-tab-button { display: none !important; }
/* ShadowFox: persistent identity marker in the browser chrome. */
#nav-bar::before {
  content: __SHADOWFOX_MARKER__ !important;
  display: flex !important;
  align-items: center !important;
  margin: 0 8px !important;
  padding: 3px 8px !important;
  border: 1px solid #d9ddff !important;
  border-radius: 5px !important;
  color: #5660c9 !important;
  background: #f1f3ff !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  white-space: nowrap !important;
  max-width: 320px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  order: 0 !important;
}
/* ShadowFox: the extensions (puzzle) button joins the right button cluster */
#nav-bar #unified-extensions-button {
  order: 900 !important;
  -moz-box-ordinal-group: 900 !important;
}
"""


# Official TabsToolbar default from the engine's CustomizableUI.sys.mjs
# (defaultPlacements). Stock layout: tabs, then "+", a spring, then
# alltabs/smartwindow/ai toggles -- the "+" the user expects at the tab
# strip tail.
TABS_TOOLBAR_DEFAULT = [
    "tabbrowser-tabs", "new-tab-button", "spring", "alltabs-button",
    "smartwindow-group-tabs-button", "ai-window-toggle",
]

# Nav-bar in the order the operator expects: nav cluster, flexible
# springs, urlbar, then ALL remaining buttons bunched at the right edge.
# Without this pin the engine's auto-add drops the unified-extensions
# (puzzle) button between the urlbar and the flexible spring, stranding
# it mid-toolbar ~800px away from the other buttons.
NAVBAR_DEFAULT = [
    "back-button", "forward-button", "stop-reload-button",
    "spring", "vertical-spacer", "urlbar-container",
    "spring", "downloads-button", "unified-extensions-button",
]


def _layout_pins() -> Dict[str, Any]:
    """Prefs that pin the tab strip and nav bar to a clean stock layout.

    They MUST travel through firefox_user_prefs (Playwright merges them
    into the user.js it writes at launch), never through a user.js we
    write ourselves: Playwright's createProfile() overwrites user.js
    wholesale on every persistent launch, so a file written a moment
    earlier never reaches the browser. That overwrite is what silently
    defeated the earlier user.js-based surgery.

    The pinned state is deliberately minimal: only the two areas we care
    about; every other area falls back to built-in defaults. This also
    discards the vertical-tabs-era fossils (extra springs, relocated
    widgets) that past runs accumulated in the saved state. Extension
    buttons (uBlock) are not pinned: they auto-add at the nav-bar end,
    right where they belong.
    """
    state = {"placements": {
        "TabsToolbar": list(TABS_TOOLBAR_DEFAULT),
        "nav-bar": list(NAVBAR_DEFAULT),
    }}
    return {
        "sidebar.verticalTabs": False,
        "browser.uiCustomization.horizontalTabstrip": "",
        "browser.uiCustomization.state": _json.dumps(state, separators=(",", ":")),
        # userChrome.css gate. This engine's userChrome loader is compiled
        # out (camoufox injects chrome styling its own way), but stock
        # builds read this pref, and user-level pins win startup races.
        "toolkit.legacyUserProfileCustomizations.stylesheets": True,
    }


def _write_user_js(profile: Path, user_prefs: Dict[str, Any]) -> None:
    """Write user.js with our pins, directly.

    Empirically, Playwright's writePreferences does NOT run on every
    persistent launch (user.js mtime stays frozen across _run launches),
    and something inside the engine occasionally rewrites user.js with a
    stale saved state. Writing it ourselves right before the launch makes
    the pins land at USER level -- the only branch that outranks the
    stale state -- no matter which of the three writers runs last.
    """
    lines = [
        f'user_pref({_json.dumps(k)}, {_json.dumps(v)});'
        for k, v in user_prefs.items()
    ]
    (profile / "user.js").write_text("\n".join(lines) + "\n", encoding="utf-8")


def userchrome_css(marker: Optional[str] = None) -> str:
    """Chrome rules with the nav-bar marker text filled in.

    The marker shows the environment's selected proxy node when there is
    one, so the operator can tell windows apart by exit node. The label is
    escaped as a CSS string; long subscription names are clipped by the
    max-width in the rule.
    """
    label = (marker or "").strip() or "Cacer · 指纹环境隔离中"
    return USERCHROME_CSS.replace(
        "__SHADOWFOX_MARKER__", _json.dumps(label, ensure_ascii=False))


def profile_dir(
        profiles_dir: Path,
        identity_id: str,
        marker: Optional[str] = None,
) -> Path:
    d = Path(profiles_dir) / identity_id / "profile"
    d.mkdir(parents=True, exist_ok=True)
    chrome = d / "chrome"
    chrome.mkdir(exist_ok=True)
    (chrome / "userChrome.css").write_text(userchrome_css(marker), encoding="utf-8")
    return d


# Marker block appended to the engine's chrome.css (see ensure_engine_chrome_css)
ENGINE_CSS_MARKER = "/* ShadowFox tab-strip rules (appended by core/launcher.py) */"


def ensure_engine_chrome_css(marker: Optional[str] = None) -> bool:
    """Idempotently maintain the ShadowFox rules in camoufox's chrome.css.

    This engine compiles the userChrome.css loader out and instead injects
    <engine-dir>/chrome.css into the browser UI (verified empirically: a
    marker rule there reached nav-bar and TabsToolbar). The state pins in
    _layout_pins() fix the placements where the state machine allows it;
    these rules are the presentation-level guarantee (the "+" at the tab
    strip tail, the puzzle button in the right cluster) that no startup
    reordering can break. The block is stripped and re-appended on every
    launch so rule updates always land; engine updates replace the whole
    directory and the next launch re-appends (self-healing).
    """
    try:
        from .engine import get_path
    except Exception:
        return False
    try:
        css_path = Path(get_path("chrome.css"))
        if not css_path.is_file():
            return False
        text = css_path.read_text(encoding="utf-8", errors="replace")
        marker_pos = text.find(ENGINE_CSS_MARKER)
        if marker_pos != -1:
            text = text[:marker_pos].rstrip()
        css_path.write_text(
            text + "\n\n" + ENGINE_CSS_MARKER + "\n" + userchrome_css(marker),
            encoding="utf-8")
        return True
    except Exception:
        log.debug("engine chrome.css update skipped", exc_info=True)
        return False


def locale_list(identity) -> list[str]:
    """The identity's languages, reordered so the first entry carries a
    region. Camoufox generates a random region when none is given -- an
    unwanted per-launch randomness source -- so we always lead with a
    region-qualified entry (same set, deterministic order)."""
    langs = list(identity.geo.languages or [identity.geo.locale])
    if langs and "-" not in langs[0]:
        regional = next((l for l in langs if "-" in l), None)
        if regional:
            langs = [regional] + [l for l in langs if l != regional]
    return langs


def ensure_password_manager() -> None:
    """Turn the engine's built-in password manager back on.

    Camoufox ships `distribution/policies.json` with PasswordManagerEnabled and
    OfferToSaveLogins set to false, and enterprise policy cannot be overridden
    by prefs. Flipping the two flags before launch (idempotent; re-applied after
    engine updates) makes Firefox offer to save logins again. Logins live in
    logins.json + key4.db inside the profile, so exports carry them.
    """
    try:
        from .engine import get_path
        path = Path(get_path("distribution/policies.json"))
    except Exception:
        return
    if not path.is_file():
        return
    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    policies = data.get("policies")
    if not isinstance(policies, dict):
        return
    if policies.get("PasswordManagerEnabled") is True and policies.get("OfferToSaveLogins") is True:
        return
    policies["PasswordManagerEnabled"] = True
    policies["OfferToSaveLogins"] = True
    try:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(_json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def _silence_gpu_probe(identity) -> None:
    """Stop camoufox from opening a throwaway window to probe the host GPU.

    camoufox's launch_options() probes the host GPU with a *headed* browser
    whenever the launch has no explicit WebGL config. That probe window flashes
    open and closes right before the real window appears on every launch. The
    identity already stores fpgen's GPU pair, so answer the probe from it.
    Only patch when the pair is present: otherwise the probe result is the
    only source of truth and guessing could contradict the fingerprint.
    """
    gpu = (identity.fingerprint or {}).get("gpu") or {}
    vendor = gpu.get("vendor")
    renderer = gpu.get("renderer")
    if not vendor or not renderer:
        return
    try:
        import camoufox.utils as camoufox_utils
    except Exception:  # camoufox missing -> launch will fail with its own error
        return
    if hasattr(camoufox_utils, "host_gpu"):
        camoufox_utils.host_gpu = lambda *args, **kwargs: (vendor, renderer)


def required_font_families(identity) -> list[str]:
    """Use the same final config as launch; disable download-only addon setup."""
    import copy
    import json
    from camoufox.utils import launch_options
    from camoufox.addons import DefaultAddons

    # Subscription routing is resolved right before launch, when the shared
    # mihomo core has a listener port. The preview never connects and drops the
    # proxy below, so a placeholder keeps validation from rejecting a valid
    # subscription-backed identity without starting the core.
    preview_proxy = None
    if identity.network_mode == "proxy" and not identity.proxy_server:
        preview_proxy = "socks5://127.0.0.1:9"

    import tempfile
    with tempfile.TemporaryDirectory(prefix="cacer-font-preview-") as temporary:
        options = build_launch_options(
            copy.deepcopy(identity), profiles_dir=Path(temporary),
            proxy_override=preview_proxy)
    options["addons"] = []
    options["exclude_addons"] = list(DefaultAddons)
    options.pop("proxy", None)
    resolved = launch_options(**options)
    chunks = sorted((int(key.rsplit("_", 1)[1]), value)
                    for key, value in resolved["env"].items()
                    if key.startswith("CAMOU_CONFIG_"))
    config = json.loads("".join(value for _, value in chunks))
    return config.get("fonts", [])


def _windows_known_downloads() -> Optional[Path]:
    """Query Windows Shell for the user's actual Downloads folder (respects
    relocation to D:\\Downloads, etc. via Explorer Properties -> Location)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        # FOLDERID_Downloads = {374DE290-123F-4565-9164-39C4925E467B}
        folder_id = _GUID(
            0x374DE290, 0x123F, 0x4565,
            (ctypes.c_ubyte * 8)(0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B),
        )
        ptr = ctypes.c_wchar_p()
        hr = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(folder_id), 0, None, ctypes.byref(ptr),
        )
        if hr == 0 and ptr.value:
            resolved = Path(ptr.value)
            ctypes.windll.ole32.CoTaskMemFree(ptr)
            return resolved
    except Exception:
        pass
    return None


def host_downloads_dir() -> Path:
    """Return the host user's actual Downloads directory (including relocated drives)."""
    downloads = _windows_known_downloads() or (Path.home() / "Downloads")
    try:
        downloads.mkdir(parents=True, exist_ok=True)
        return downloads
    except OSError:
        return Path.home()


def build_launch_options(
    identity,
    *,
    profiles_dir: Path = Path("profiles"),
    proxy_override: Optional[str] = None,
    marker_label: Optional[str] = None,
) -> Dict[str, Any]:
    """All Camoufox() kwargs for launching this identity headed.

    network_mode="direct" -> no proxy at all.
    network_mode="proxy" -> either the stored proxy_server or the caller's
    proxy_override (this identity's listener on the subscription's shared
    mihomo core).
    """
    violations = identity.violations()
    if violations:
        raise ValueError(
            f"identity {identity.id} has coherence violations: "
            + "; ".join(violations[:3])
        )
    for warning in identity.warnings():
        log.info("identity %s (%s): %s", identity.id, identity.name, warning)

    config: Dict[str, Any] = {
        # fpgen's maxTouchPoints=0 is dropped by camoufox's falsy-skip, which
        # leaks a touchscreen host's digitizer; always set it explicitly.
        "navigator.maxTouchPoints": identity.launcher.maxTouchPoints,
        # Reported == measurable: no pinning, so report the host count
        # snapped into plausible desktop values (mirrors camoufox's own
        # no-pin behaviour; setting navigator.* ourselves disables theirs).
        "navigator.hardwareConcurrency": identity.launcher.hardwareConcurrency,
        # Freeze the identity's geo; a Tor circuit must never move it.
        "timezone": identity.geo.timezone,
    }

    downloads_dir = host_downloads_dir()
    options: Dict[str, Any] = {
        "fingerprint": identity.fingerprint,
        "config": config,
        "locale": locale_list(identity),
        "i_know_what_im_doing": True,
        "main_world_eval": True,
        "headless": False,
        "humanize": True,
        "persistent_context": True,
        "user_data_dir": str(profile_dir(profiles_dir, identity.id, marker_label)),
        "accept_downloads": True,
        "downloads_path": str(downloads_dir),
    }

    from .engine import bundled_executable
    executable = bundled_executable()
    if executable is not None:
        options["executable_path"] = str(executable)

    # Browser chrome prefs. Layout pins MUST ride in firefox_user_prefs:
    # Playwright's launch writes user.js itself (defaultPrefs + these), so
    # anything we want applied at startup has to flow through this dict.
    user_prefs: Dict[str, Any] = dict(_layout_pins())
    # Browser chrome language is decoupled from the identity's web-facing
    # locale: menus/dialogs can stay Chinese while pages still see the
    # country locale (navigator.language / Accept-Language come from
    # locale= above). camoufox setdefault()s this pref, so the chosen value
    # wins. Always write it -- "" means follow the identity -- otherwise a
    # language chosen in an earlier launch survives in prefs.js.
    user_prefs["intl.locale.requested"] = (
        identity.launcher.ui_locale or identity.geo.locale)
    if identity.launcher.memory_cache:
        # The engine's camoufox.cfg turns Firefox's memory cache off
        # (browser.cache.memory.enable=false, "force disk cache"). That makes
        # every revisit and back/forward read from disk and re-fetch over the
        # proxy, which is painful when each request already pays the node RTT.
        # Restoring the stock Firefox memory cache is a pure performance win;
        # operators can opt out per identity.
        user_prefs["browser.cache.memory.enable"] = True
    # The engine's de-bloat cfg disables the built-in password manager
    # (signon.rememberSignons=false). Turn it back on so accounts typed into
    # a site can be stored in this environment: Firefox writes logins.json +
    # key4.db into the profile, and "导出身份" archives the whole profile, so
    # saved credentials travel with the environment.
    user_prefs.update({
        "signon.rememberSignons": True,
        "signon.autofillForms": True,
        "signon.formlessCapture.enabled": True,
        "signon.management.page.breach-alerts.enabled": False,
    })
    # Extension center: add-ons are installed into the profile as unpacked
    # directories (see sync_profile_extensions) so their settings survive
    # restarts. Profile-scanned add-ons must auto-enable instead of waiting for
    # the user to confirm them in about:addons, and local XPI imports are not
    # Mozilla-signed, so signature enforcement is relaxed -- the same trust
    # model as installing an extension manually.
    user_prefs.update({
        "extensions.autoDisableScopes": 0,
        "xpinstall.signatures.required": False,
        "browser.download.folderList": 2,
        "browser.download.dir": str(downloads_dir),
        "browser.download.useDownloadDir": True,
        "browser.download.alwaysOpenPanel": True,
    })
    if identity.network_mode == "direct" and not proxy_override:
        # Omitting Playwright's proxy option leaves Firefox using the system
        # proxy (type=5), or a saved profile proxy. Pin direct mode on every
        # launch, both through Camoufox and the persistent user.js below.
        user_prefs["network.proxy.type"] = 0
    if identity.network_mode == "proxy" or proxy_override:
        # Two safety pins for proxied environments. A dead listener must fail
        # closed instead of quietly connecting from the host IP, and socks
        # lookups must happen at the proxy: local DNS is frequently poisoned.
        user_prefs["network.proxy.failover_direct"] = False
        user_prefs["network.proxy.socks_remote_dns"] = True
    options["firefox_user_prefs"] = user_prefs
    # And write the same pins to user.js ourselves: Playwright's
    # writePreferences does not run on every launch, so the file (and the
    # USER-level branch it populates) cannot be left to chance.
    _write_user_js(Path(options["user_data_dir"]), user_prefs)

    if proxy_override:
        # Subscription routing: the caller attached this identity to the
        # subscription's shared core and knows its listener port.
        options["proxy"] = {"server": proxy_override}
    elif identity.network_mode == "proxy":
        if not identity.proxy_server:
            # Never fall through to a direct connection: an identity routed
            # through a proxy must not leak the real IP when the proxy is gone.
            raise ValueError(
                f"identity {identity.id} requires a proxy but none is configured"
            )
        options["proxy"] = {"server": identity.proxy_server}

    # Extension center: one global repository, each identity only records the
    # slugs it skips. The enabled set is mirrored into the profile's
    # extensions/ folder before every launch, which makes the add-ons permanent
    # (settings persist) while keeping the switch a start-up file operation --
    # it never touches the stored fingerprint, cookies or cache. The engine's
    # bundled uBlock is part of the mirror, so its default temporary copy is
    # always excluded to avoid loading it twice.
    try:
        from .extensions import sync_profile_extensions
        sync_profile_extensions(
            options["user_data_dir"], profiles_dir, identity.disabled_extensions)
    except Exception:
        log.debug("extension sync skipped", exc_info=True)
    try:
        from camoufox import DefaultAddons
        options["exclude_addons"] = [DefaultAddons.UBO]
    except Exception:
        log.debug("camoufox DefaultAddons unavailable", exc_info=True)

    # Engine-level CSS insurance for the tab-strip "+" (idempotent, and
    # re-applied automatically after engine updates).
    from .branding import ensure_browser_branding
    ensure_browser_branding()
    ensure_engine_chrome_css(marker_label)
    ensure_password_manager()

    # Must run before Camoufox() calls launch_options(), otherwise the headed
    # GPU probe window flashes on every start.
    _silence_gpu_probe(identity)

    return options
