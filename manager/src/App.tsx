import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  ClashConfig, CreateRequest, DataOverview, EditRequest, ExtensionItem, ExtensionSearchResult, HistoryItem, Identity, ProxyNode, ProxySource,
  cancelRuntime, installRuntime, runtimeStatus, setupLocalPython, pickPythonPath, type RuntimeStatus,
  checkUpdate, downloadUpdate, updateStatus, cancelUpdate, installUpdate, type UpdateInfo, type UpdateStatus,
  saveDownloadSettings, fontOverview, type FontOverview,
  clashConfigs, cloneIdentity, createIdentity, dataOverview, deleteIdentity, editIdentity, environmentCheck,
  exportAllData, exportCookies, exportPack, extImport, extInstall, extList, extRemove, extSearch, importAllData, importPack, launchHistory, launchIdentity, listIdentities, openDataDir,
  proxyDelete, proxyImport, proxyNodes, proxyRename, proxySetCore, proxySources, rebuildIdentity, reorderIdentities, stopIdentity, type EnvironmentCheck,
} from "./api";
import Flag from "./Flag";
import Modal from "./Modal";

const APP_ICON = new URL("../app-icon.png", import.meta.url).href;

const OS_OPTIONS = [
  { value: "", label: "自动匹配" },
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
];
const COUNTRY_OPTIONS = [
  ["", "自动选择"], ["US", "美国"], ["CA", "加拿大"], ["GB", "英国"],
  ["FR", "法国"], ["DE", "德国"], ["ES", "西班牙"], ["IT", "意大利"],
  ["NL", "荷兰"], ["SE", "瑞典"], ["CH", "瑞士"], ["AU", "澳大利亚"],
  ["JP", "日本"], ["KR", "韩国"], ["SG", "新加坡"], ["IN", "印度"],
  ["BR", "巴西"], ["CN", "中国"], ["TW", "中国台湾"], ["HK", "中国香港"],
] as const;
const OS_LABELS: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
const OS_ICONS: Record<string, string> = { windows: "▣", macos: "●", linux: "◆" };

type View = "overview" | "environments" | "proxy" | "extensions" | "history" | "fonts";
const VIEW_LABEL: Record<View, string> = {
  overview: "总览", environments: "浏览器环境", proxy: "代理管理", extensions: "扩展中心", history: "启动记录", fonts: "字体库",
};
const EVENT_LABEL: Record<string, string> = { launch: "启动", stop: "停止", closed: "关闭窗口" };
const EXT_SOURCE_LABEL: Record<string, string> = { engine: "引擎内置", amo: "官方商店", local: "本地导入" };

function formatUsers(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万`;
  return String(count);
}

/// Sentinel shared with the Rust downloaders: every mirror and GitHub failed.
const DOWNLOAD_ROUTES_FAILED = "所有下载线路均失败";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatStamp(seconds: number): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyForm(): CreateRequest { return { name: "", note: "", os: "", country: "", network: "direct", ui_locale: "zh-CN", memory_cache: true }; }



/// The table row is a single line: strip any breaks so notes never introduce
/// blank space or wrap oddly there.
function inlineNote(note: string): string {
  return note.replace(/\s*\n+\s*/g, " ").trim();
}



function Icon({ children }: { children: ReactNode }) { return <span className="nav-icon">{children}</span>; }

function ButtonLabel({ busy, idle, pending }: { busy: boolean; idle: string; pending: string }) {
  return <span className="button-label">
    <span className="button-label-size" aria-hidden="true">{idle}</span>
    <span className="button-label-size" aria-hidden="true"><span className="button-spinner" />{pending}</span>
    <span className="button-label-content">{busy && <span className="button-spinner" aria-hidden="true" />}{busy ? pending : idle}</span>
  </span>;
}

function PendingButton({ busy, idle, pending, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-busy"> & {
  busy: boolean; idle: string; pending: string;
}) {
  return <button {...props} disabled={disabled || busy} aria-busy={busy}>
    <ButtonLabel busy={busy} idle={idle} pending={pending} />
  </button>;
}

type EnvCardAction = "local-python" | "pick-dir" | "manual" | "engine";

/// One card per environment check: green checkmark when installed, actionable
/// buttons on the right when a missing piece can be fixed from here.
function EnvChecks(props: {
  checks: EnvironmentCheck["checks"];
  pythonDetected?: boolean;
  onAction?: (action: EnvCardAction) => void;
  busy?: boolean;
}) {
  return <div className="env-checks">{props.checks.map((check) => {
    return <div className={`env-card ${check.ok ? "ok" : "bad"}`} key={check.key}>
      <span className="env-mark">{check.ok ? "✓" : "!"}</span>
      <div className="env-copy"><strong>{check.label}</strong><p>{check.detail}</p></div>
      {!check.ok && props.onAction && check.key === "dependencies" && props.pythonDetected && (
        <button className="primary env-action env-action-primary" disabled={props.busy} onClick={() => props.onAction?.("local-python")}>一键安装依赖</button>
      )}
      {!check.ok && props.onAction && check.key === "python" && (
        <div className="env-actions">
          <button className="primary env-action env-action-primary" disabled={props.busy} onClick={() => props.onAction?.("pick-dir")}>选择本地目录</button>
          <button className="secondary env-action" disabled={props.busy} onClick={() => props.onAction?.("manual")}>手动安装</button>
        </div>
      )}
      {!check.ok && props.onAction && check.key === "engine" && (
        <button className="secondary env-action" disabled={props.busy} onClick={() => props.onAction?.("engine")}>重新安装说明</button>
      )}
    </div>;
  })}</div>;
}

export default function App() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const nodeRequests = useRef({ create: 0, edit: 0 });
  const refreshRequest = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState<CreateRequest>(emptyForm());
  const [editTarget, setEditTarget] = useState<Identity | null>(null);
  const [editForm, setEditForm] = useState<EditRequest>({});
  const [netChoice, setNetChoice] = useState<"direct" | "sub" | "custom">("direct");
  const [editNetChoice, setEditNetChoice] = useState<"direct" | "sub" | "custom">("direct");
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const runtimeBusyRef = useRef(false);
  const [downloadState, setDownloadState] = useState<RuntimeStatus | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateStatus | null>(null);
  const updateBusy = useRef(false);
  const [appVersion, setAppVersion] = useState("…");
  const [checkingEnvironment, setCheckingEnvironment] = useState(false);
  const [showProxy, setShowProxy] = useState(false);
  const [proxyStep, setProxyStep] = useState<"ask" | "input">("ask");
  const [proxyValue, setProxyValue] = useState("");
  const [failedTask, setFailedTask] = useState<"python" | "local-python" | "fonts" | null>(null);
  const proxyRetry = useRef<((proxy: string) => void) | null>(null);
  const [fontPlan, setFontPlan] = useState<FontOverview | null>(null);
  const [fontCountry, setFontCountry] = useState("");
  const [fontIdentity, setFontIdentity] = useState("");
  const [selectedFonts, setSelectedFonts] = useState<string[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const fontRequest = useRef(0);
  const [pendingLaunch, setPendingLaunch] = useState<string | null>(null);
  const [pythonPath, setPythonPath] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const environmentRef = useRef<EnvironmentCheck | null>(null);
  const [copied, setCopied] = useState(false);
  const [proxySourceList, setProxySourceList] = useState<ProxySource[]>([]);
  const [proxyCore, setProxyCore] = useState<{ found: boolean; path: string | null } | null>(null);
  const [subNodes, setSubNodes] = useState<ProxyNode[]>([]);
  const [editSubNodes, setEditSubNodes] = useState<ProxyNode[]>([]);
  const [localClashConfigs, setLocalClashConfigs] = useState<ClashConfig[]>([]);
  const [showClash, setShowClash] = useState(false);
  const [clashLabels, setClashLabels] = useState<Record<string, string>>({});
  const [subBusy, setSubBusy] = useState<string | null>(null);
  const [view, setView] = useState<View>("environments");
  const [notice, setNotice] = useState<string | null>(null);
  const [dataInfo, setDataInfo] = useState<DataOverview | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [noteTip, setNoteTip] = useState<{ x: number; y: number; above: boolean; text: string } | null>(null);
  const [extItems, setExtItems] = useState<ExtensionItem[]>([]);
  const [extResults, setExtResults] = useState<ExtensionSearchResult[]>([]);
  const [extQuery, setExtQuery] = useState("");
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const [extSearched, setExtSearched] = useState(false);

  // Poll fast only while something is actually transitioning; an idle window
  // does not need a Python process every 3 seconds.
  const hasActive = identities.some((it) => it.running || it.status === "starting");

  useEffect(() => {
    checkEnvironment();
    // Startup update probe: a failed check must never disturb the workflow.
    checkUpdate().then((info) => { if (info.available) setUpdate(info); }).catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  useEffect(() => {
    if (view === "fonts") loadFontPlan();
  }, [view, fontCountry, fontIdentity]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, hasActive ? 3000 : 10000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasActive]);
  useEffect(() => {
    if (view === "proxy") { loadProxy(); }
    if (view === "extensions") { loadExtensions(); }
    if (view === "history") loadHistory();
    if (view === "overview" || view === "proxy") loadData();
  }, [view]);
  // The webview's native context menu (reload / inspect / print) has no place
  // in an app window; keep it off until a real right-click action exists.
  useEffect(() => {
    const block = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);
  function refresh(afterMutation = false): Promise<void> {
    if (!environmentRef.current?.ready) return Promise.resolve();
    // Polls share a pending read; completed mutations request one fresh read.
    if (refreshRequest.current) {
      if (afterMutation) refreshQueued.current = true;
      return refreshRequest.current;
    }
    refreshQueued.current = true;
    refreshRequest.current = (async () => {
      while (refreshQueued.current) {
        refreshQueued.current = false;
        try { setIdentities(await listIdentities()); }
        catch (e) { setError(String(e)); }
      }
    })().finally(() => { refreshRequest.current = null; });
    return refreshRequest.current;
  }
  async function checkEnvironment() {
    setCheckingEnvironment(true);
    try {
      const result = await environmentCheck();
      environmentRef.current = result;
      setEnvironment(result);
      if (!result.python_detected) setManualOpen(true);
      if (result.ready) { setError(null); await refresh(true); await loadExtensions(); }
      return result;
    } catch (e) { setEnvironment(null); environmentRef.current = null; setError(String(e)); return null; }
    finally { setCheckingEnvironment(false); }
  }
  /// Every mirror and the system proxy failed: first ask whether to configure
  /// one; the address is only requested after the user agrees.
  function offerProxy(retry: (proxy: string) => void) {
    proxyRetry.current = retry;
    setProxyValue("");
    setProxyStep("ask");
    setShowProxy(true);
  }
  async function applyProxy(clear = false) {
    const proxy = clear ? "" : proxyValue.trim();
    if (!clear && !proxy) return;
    try {
      await saveDownloadSettings({ proxy, mirror: "" });
      setShowProxy(false);
      setError(null);
      const retry = proxyRetry.current;
      proxyRetry.current = null;
      retry?.(proxy);
    } catch (e) { setError(String(e)); }
  }
  async function clearDownloadProxy() {
    try {
      await saveDownloadSettings({ proxy: "", mirror: "" });
      setNotice("已清除下载代理，后续下载将自动检测系统代理");
    } catch (e) { setError(String(e)); }
  }
  async function setupRuntime(kind: "python" | "fonts", fontIds: string[] = [], proxyOverride?: string): Promise<boolean> {
    if (runtimeBusyRef.current) return false;
    runtimeBusyRef.current = true;
    setRuntimeBusy(true);
    setError(null);
    setDownloadState({ busy: true, message: "正在准备", downloaded: 0, total: 0 });
    const timer = window.setInterval(() => runtimeStatus().then(setDownloadState).catch(() => {}), 500);
    try {
      await installRuntime(kind, proxyOverride ?? "", fontIds);
      if (kind === "fonts") await loadFontPlan();
      await checkEnvironment();
      setNotice(kind === "python" ? "Python 与依赖已准备完成" : "浏览器字体已准备完成，后续可离线使用");
      return true;
    } catch (e) {
      const message = String(e);
      if (message.includes("已取消")) {
        setError(null);
      } else if (!message.includes(DOWNLOAD_ROUTES_FAILED)) {
        setError(message);
      } else if (proxyOverride !== undefined) {
        // A proxy was already supplied and still failed: stop looping and
        // hand the user manual commands instead.
        setCopied(false);
        setFailedTask(kind);
      } else {
        void offerProxy((retryProxy) => { void setupRuntime(kind, fontIds, retryProxy); });
      }
      return false;
    }
    finally {
      window.clearInterval(timer);
      runtimeBusyRef.current = false;
      setRuntimeBusy(false);
      setDownloadState(null);
    }
  }
  async function startUpdate(proxyRetried = false) {
    if (updateBusy.current || !update) return;
    updateBusy.current = true;
    setError(null);
    setUpdateState({ busy: true, message: "正在准备下载", downloaded: 0, total: update.size });
    const timer = window.setInterval(() => updateStatus().then(setUpdateState).catch(() => {}), 500);
    try {
      await downloadUpdate();
      window.clearInterval(timer);
      setUpdateState({ busy: true, message: "下载完成，正在验证并启动安装程序…", downloaded: update.size, total: update.size });
      await installUpdate();
      setNotice("安装程序已启动，Cacer 即将退出完成更新");
    } catch (e) {
      const message = String(e);
      if (message.includes(DOWNLOAD_ROUTES_FAILED)) {
        if (proxyRetried) setError("重试后仍无法下载更新包，请检查网络或稍后重试。");
        else void offerProxy(() => { void startUpdate(true); });
      } else setError(message);
    } finally {
      window.clearInterval(timer);
      updateBusy.current = false;
      setUpdateState(null);
    }
  }
  async function loadFontPlan() {
    const request = ++fontRequest.current;
    setFontLoading(true);
    try {
      const plan = await fontOverview(fontIdentity, fontCountry);
      if (request !== fontRequest.current) return;
      setFontPlan(plan);
      setSelectedFonts(plan.packs.filter((pack) => pack.required && !pack.cached).map((pack) => pack.id));
    } catch (e) { if (request === fontRequest.current) { setFontPlan(null); setError(String(e)); } }
    finally { if (request === fontRequest.current) setFontLoading(false); }
  }
  async function downloadAndLaunch() {
    if (!pendingLaunch || !fontPlan || fontLoading) return;
    const id = pendingLaunch;
    if (await setupRuntime("fonts", fontPlan.packs.filter((pack) => pack.required).map((pack) => pack.id))) {
      await launchIdentity(id); setPendingLaunch(null); setView("environments");
    }
  }
  async function setupLocalRuntime(customPath?: string, proxyOverride?: string): Promise<boolean> {
    if (runtimeBusyRef.current) return false;
    runtimeBusyRef.current = true;
    setRuntimeBusy(true);
    setError(null);
    setDownloadState({ busy: true, message: "正在检查本机 Python…", downloaded: 0, total: 0 });
    const timer = window.setInterval(() => runtimeStatus().then(setDownloadState).catch(() => {}), 400);
    try {
      await setupLocalPython(customPath, proxyOverride ?? "");
      await checkEnvironment();
      setNotice("已复用本机 Python 完成依赖配置，后续可直接运行");
      return true;
    } catch (e) {
      const message = String(e);
      if (message.includes("已取消")) {
        setError(null);
      } else if (!message.includes(DOWNLOAD_ROUTES_FAILED)) {
        setError(message);
      } else if (proxyOverride !== undefined) {
        setCopied(false);
        setFailedTask("local-python");
      } else {
        void offerProxy((retryProxy) => { void setupLocalRuntime(customPath, retryProxy); });
      }
      return false;
    } finally {
      window.clearInterval(timer);
      runtimeBusyRef.current = false;
      setRuntimeBusy(false);
      setDownloadState(null);
    }
  }
  async function browsePython(kind: "dir" | "file", autoSetup = false) {
    if (runtimeBusyRef.current) return;
    setError(null);
    try {
      const chosen = await pickPythonPath(kind);
      if (!chosen) return;
      setPythonPath(chosen);
      if (autoSetup) {
        await setupLocalRuntime(chosen);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function applyPython() {
    if (!pythonPath.trim()) return;
    await setupLocalRuntime(pythonPath);
  }
  async function launchPrepared(id: string) {
    if (!environmentRef.current?.ready) { setError("运行环境未就绪，请先安装 Python 依赖。"); return; }
    const plan = await fontOverview(id);
    if (!plan.ready) {
      setFontIdentity(id); setFontCountry(""); setFontPlan(plan);
      setSelectedFonts(plan.packs.filter((pack) => pack.required && !pack.cached).map((pack) => pack.id));
      setPendingLaunch(id); setView("fonts");
      setNotice("该环境缺少字体，请核对下方下载计划后选择「下载所需并启动」。");
      return;
    }
    await launchIdentity(id);
  }
  const guideText = environment?.manual_commands ?? "正在读取安装命令…";
  function handleEnvAction(action: EnvCardAction) {
    if (action === "engine") {
      setError("浏览器引擎随安装包提供，若文件缺失请重新安装当前版本。");
      return;
    }
    if (action === "local-python") {
      void setupLocalRuntime();
      return;
    }
    if (action === "pick-dir") {
      void browsePython("dir", true);
      return;
    }
    setManualOpen(true);
    openSettings();
  }
  async function copyGuide() {
    try {
      await navigator.clipboard.writeText(guideText);
    } catch {
      const area = document.createElement("textarea");
      area.value = guideText;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  async function withBusy<T>(key: string, op: () => Promise<T>) {
    // The ref also blocks double clicks before React commits the next render.
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try { await op(); await refresh(true); }
    catch (e) { setError(String(e)); await refresh(true); }
    finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  }
  async function loadProxy() {
    if (!environmentRef.current?.ready) return [];
    try {
      const overview = await proxySources();
      setProxySourceList(overview.sources);
      setProxyCore(overview.core);
      return overview.sources;
    } catch (e) { setError(String(e)); return []; }
  }
  async function loadNodes(source: string, forEdit: boolean) {
    const slot = forEdit ? "edit" : "create";
    const request = ++nodeRequests.current[slot];
    const update = forEdit ? setEditSubNodes : setSubNodes;
    update([]);
    if (!source) return;
    try {
      const result = await proxyNodes(source);
      if (request === nodeRequests.current[slot]) update(result.nodes);
    } catch (e) {
      if (request === nodeRequests.current[slot]) setError(String(e));
    }
  }
  async function scanClash() {
    setError(null);
    setSubBusy("正在扫描 Clash 配置…");
    try {
      const configs = (await clashConfigs()).configs;
      setLocalClashConfigs(configs);
      setClashLabels(Object.fromEntries(configs.map((c) => [c.path, c.name])));
      setShowClash(true);
      if (!configs.length) flash("没有扫描到包含节点的 Clash 配置");
    } catch (e) { setError(String(e)); }
    finally { setSubBusy(null); }
  }
  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  }
  async function loadData() {
    try { setDataInfo(await dataOverview()); } catch (e) { setError(String(e)); }
  }
  async function loadHistory() {
    if (!environmentRef.current?.ready) return;
    try { setHistory((await launchHistory(80)).items); } catch (e) { setError(String(e)); }
  }
  async function loadExtensions() {
    if (!environmentRef.current?.ready) return;
    try { setExtItems((await extList()).extensions); } catch (e) { setError(String(e)); }
  }
  function searchExtensions() {
    const query = extQuery.trim();
    if (!query || extBusy) return;
    setError(null);
    setExtBusy("search");
    extSearch(query, 20)
      .then((data) => { setExtResults(data.results); setExtSearched(true); })
      .catch((e) => setError(String(e)))
      .finally(() => setExtBusy(null));
  }
  function installExtension(slug: string) {
    setError(null);
    setExtBusy(`install-${slug}`);
    extInstall(slug)
      .then(async (item) => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === slug ? { ...result, installed: true } : result));
        flash(`已安装 ${item.name}，所有环境默认启用`);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setExtBusy(null));
  }
  function importExtension() {
    const path = window.prompt("导入扩展：填写 .xpi / .zip 安装包的完整路径，或已解压扩展文件夹的路径。", "");
    if (!path?.trim()) return;
    setError(null);
    setExtBusy("import");
    extImport(path.trim())
      .then(async (item) => { await loadExtensions(); flash(`已导入 ${item.name}，所有环境默认启用`); })
      .catch((e) => setError(String(e)))
      .finally(() => setExtBusy(null));
  }
  function removeExtension(item: ExtensionItem) {
    if (!window.confirm(`确定卸载“${item.name}”吗？\n\n卸载后所有环境都不再加载它。`)) return;
    setError(null);
    setExtBusy(`remove-${item.slug}`);
    extRemove(item.slug)
      .then(async () => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === item.slug ? { ...result, installed: false } : result));
        flash(`已卸载 ${item.name}`);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setExtBusy(null));
  }
  function toggleEditExtension(slug: string, enabled: boolean) {
    const disabled = editForm.disabled_extensions ?? [];
    setEditForm({
      ...editForm,
      disabled_extensions: enabled
        ? disabled.filter((value) => value !== slug)
        : Array.from(new Set([...disabled, slug])),
    });
  }
  function openDataFolder() { openDataDir().catch((e) => setError(String(e))); }
  function openSettings() { setError(null); setShowSettings(true); loadData(); }
  function openCreate() { if (busyRef.current.has("create")) return; loadNodes("", false); setError(null); setForm(emptyForm()); setNetChoice("direct"); setSubNodes([]); setShowCreate(true); loadProxy(); }
  function chooseSubSource(source: string, forEdit: boolean) {
    if (forEdit) setEditForm({ ...editForm, proxy_source: source, proxy_node: "" });
    else setForm({ ...form, proxy_source: source || null, proxy_node: null });
    loadNodes(source, forEdit);
  }
  async function doImport(kind: "file" | "url", value: string, label = "") {
    setError(null);
    setSubBusy("正在导入订阅…");
    try {
      const result = await proxyImport(kind, value, "", label);
      await loadProxy();
      setSubBusy(`已导入 ${result.label}（${result.count} 个节点）`);
      window.setTimeout(() => setSubBusy(null), 2500);
    } catch (e) { setError(String(e)); setSubBusy(null); }
  }
  function importBy(kind: "file" | "url") {
    const value = window.prompt(kind === "file" ? "Clash 配置文件完整路径" : "Clash 订阅链接（http/https）");
    if (!value?.trim()) return;
    const label = window.prompt("订阅备注名（留空自动命名）", "");
    doImport(kind, value.trim(), (label ?? "").trim());
  }
  function importFromClash(config: ClashConfig) {
    doImport("file", config.path, (clashLabels[config.path] ?? config.name).trim());
  }
  async function importAllClash() {
    if (!localClashConfigs.length) return;
    setError(null);
    try {
      const total = localClashConfigs.length;
      for (let index = 0; index < total; index += 1) {
        const config = localClashConfigs[index];
        setSubBusy(`正在导入 ${index + 1}/${total}：${config.name}`);
        await proxyImport("file", config.path, "", (clashLabels[config.path] ?? config.name).trim());
      }
      await loadProxy();
      setShowClash(false);
      flash(`已导入 ${total} 个 Clash 配置`);
    } catch (e) { setError(String(e)); }
    finally { setSubBusy(null); }
  }
  function renameSource(source: ProxySource) {
    const next = window.prompt(`为「${source.label}」设置备注名（留空恢复默认）`, source.label);
    if (next === null) return;
    setSubBusy("正在保存备注名…");
    proxyRename(source.name, next.trim())
      .then(loadProxy)
      .catch((e) => setError(String(e)))
      .finally(() => setSubBusy(null));
  }
  function removeSource(source: ProxySource) {
    if (!window.confirm(`删除订阅“${source.label}”？使用该订阅节点的环境需要重新选择节点。`)) return;
    setSubBusy("正在删除…");
    proxyDelete(source.name)
      .then(loadProxy)
      .catch((e) => setError(String(e)))
      .finally(() => setSubBusy(null));
  }
  function pickCore() {
    const path = window.prompt("mihomo 内核路径（mihomo.exe）");
    if (!path?.trim()) return;
    setSubBusy("正在检测内核…");
    proxySetCore(path.trim())
      .then(setProxyCore)
      .catch((e) => setError(String(e)))
      .finally(() => setSubBusy(null));
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return identities;
    return identities.filter((it) => [it.name, it.note, it.country, it.os, it.proxy_server ?? "", it.proxy_node ?? ""].join(" ").toLowerCase().includes(q));
  }, [identities, search]);
  const running = identities.filter((it) => it.running || it.status === "starting").length;
  const proxyCount = identities.filter((it) => it.network_mode !== "direct").length;
  const canDrag = !search.trim() && identities.length > 1;

  function startDrag(event: DragEvent<HTMLTableRowElement>, id: string) {
    if (!canDrag) return;
    hideNoteTip();
    setDragId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }
  function overRow(event: DragEvent<HTMLTableRowElement>, id: string) {
    // Fall back to the drag payload: the first dragover can arrive before
    // React commits the dragId state set in dragstart.
    if (!dragId && !event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverId !== id) setDragOverId(id);
  }
  function dropRow(event: DragEvent<HTMLTableRowElement>, targetId: string) {
    event.preventDefault();
    const sourceId = dragId ?? event.dataTransfer.getData("text/plain");
    setDragId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = identities.map((it) => it.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    const byId = new Map(identities.map((it) => [it.id, it]));
    setIdentities(next.map((id) => byId.get(id)).filter((it): it is Identity => !!it));
    reorderIdentities(next).then(() => refresh(true)).catch((e) => { setError(String(e)); refresh(true); });
  }
  function endDrag() {
    setDragId(null);
    setDragOverId(null);
  }
  function showNoteTip(event: ReactMouseEvent<HTMLSpanElement>, note: string) {
    // Show for every environment that has a note: relying on "is it clipped"
    // made borderline notes (and therefore most rows) silently skip the
    // bubble. An empty note has nothing to show.
    if (!note || dragId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const above = rect.bottom + 150 > window.innerHeight;
    setNoteTip({
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 380)),
      y: above ? rect.top : rect.bottom + 8,
      above,
      text: note,
    });
  }
  function hideNoteTip() {
    setNoteTip(null);
  }

  const create = () => {
    setError(null);
    return withBusy("create", async () => {
    const payload: CreateRequest = {
      ...form,
      network: netChoice === "direct" ? "direct" : "proxy",
      proxy_server: netChoice === "custom" ? form.proxy_server : null,
      proxy_source: netChoice === "sub" ? form.proxy_source : null,
      proxy_node: netChoice === "sub" ? form.proxy_node : null,
    };
    await createIdentity(payload); setForm(emptyForm()); setNetChoice("direct"); setShowCreate(false);
    });
  };
  function openEdit(it: Identity) {
    setError(null);
    const subscription = it.network_mode !== "direct" && !!it.proxy_source && !!it.proxy_node;
    setEditTarget(it);
    setEditForm({
      name: it.name, note: it.note, os: it.os, country: it.country,
      network: it.network_mode === "direct" ? "direct" : "proxy",
      proxy_server: it.proxy_server ?? "",
      proxy_source: it.proxy_source ?? "",
      proxy_node: it.proxy_node ?? "",
      ui_locale: it.ui_locale ?? "",
      memory_cache: it.memory_cache ?? true,
      disabled_extensions: it.disabled_extensions ?? [],
    });
    setEditNetChoice(it.network_mode === "direct" ? "direct" : subscription ? "sub" : "custom");
    loadNodes(subscription ? it.proxy_source ?? "" : "", true);
    loadProxy();
    loadExtensions();
  }
  const exportCurrent = () => {
    if (!editTarget) return;
    withBusy(`export-${editTarget.id}`, async () => {
      const result = await exportPack(editTarget.id, editTarget.name);
      await loadData();
      flash(`已导出到 ${result.file}`);
    });
  };
  const exportCookiesCurrent = () => {
    if (!editTarget) return;
    const file = window.prompt("请输入 Cookie JSON 文件的保存路径。文件可能包含网站登录凭据，请保存在仅自己可访问的位置。", `${editTarget.name || editTarget.id}-cookies.json`);
    if (!file?.trim()) return;
    withBusy(`cookies-${editTarget.id}`, () => exportCookies(editTarget.id, file.trim()));
  };
  const importArchive = (file: string) => withBusy(`import-${file}`, async () => {
    await importPack(file);
    await loadData();
    flash(`已导入身份包 ${file}`);
  });
  const exportAll = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = window.prompt("导出全部数据：所有环境（含账号密码）、订阅、设置与启动记录。\n只填文件名会保存到系统「下载」文件夹。", `cacer-data-${stamp}.zip`);
    if (!file?.trim()) return;
    withBusy("export-all", async () => {
      const result = await exportAllData(file.trim());
      await loadData();
      flash(`已导出 ${result.files} 个文件到 ${result.archive}`);
    });
  };
  const importAll = () => {
    const file = window.prompt("导入数据包（.zip）：可填完整路径，或「下载」文件夹里的文件名。同名文件会被覆盖。", "");
    if (!file?.trim()) return;
    withBusy("import-all", async () => {
      const result = await importAllData(file.trim());
      await loadData();
      flash(`已恢复 ${result.files} 个文件到 ${result.data}`);
    });
  };
  const cloneEnvironment = () => {
    if (!editTarget) return;
    const name = window.prompt("新环境名称", `${editTarget.name}-副本`);
    if (!name?.trim()) return;
    withBusy(`clone-${editTarget.id}`, async () => {
      await cloneIdentity(editTarget.id, name.trim());
      setEditTarget(null);
    });
  };
  const saveEdit = () => withBusy(`edit-${editTarget!.id}`, async () => {
    const live = !!editTarget!.running || editTarget!.status === "starting";
    const fingerprintChanged = editForm.os !== editTarget!.os || editForm.country !== editTarget!.country;
    if (!live && fingerprintChanged && !window.confirm("修改国家或系统将生成新的设备指纹，并清空当前浏览器缓存。原有 Cookie 和登录状态可能失效。是否继续？")) return;
    // A running helper keeps its routing; only metadata that lives in
    // identity.json is safe to change. The next launch picks up language/cache.
    const req: EditRequest = live
      ? { name: editForm.name, note: editForm.note, ui_locale: editForm.ui_locale, memory_cache: editForm.memory_cache, disabled_extensions: editForm.disabled_extensions ?? [] }
      : {
        ...editForm,
        network: editNetChoice === "direct" ? "direct" : "proxy",
        proxy_server: editNetChoice === "custom" ? editForm.proxy_server : "",
        proxy_source: editNetChoice === "sub" ? editForm.proxy_source : "",
        proxy_node: editNetChoice === "sub" ? editForm.proxy_node : "",
        clear_proxy: editNetChoice === "direct",
      };
    await editIdentity(editTarget!.id, req);
    if (!live && fingerprintChanged) await rebuildIdentity(editTarget!.id, editForm.os ?? "", editForm.country ?? "");
    setEditTarget(null);
  });
  const remove = (it: Identity) => { if (window.confirm(`确定删除“${it.name}”吗？\n\n默认只删除身份配置，不删除浏览器数据。`)) withBusy(`del-${it.id}`, () => deleteIdentity(it.id, false)); };
  const valid = form.name.trim().length > 0 && (netChoice === "direct" || (netChoice === "sub" ? !!form.proxy_source && !!form.proxy_node : !!form.proxy_server?.trim()));
  const editBusy = !!editTarget && ["cookies", "export", "clone", "edit"].some((action) => busy.has(`${action}-${editTarget.id}`));
  const editLive = !!editTarget?.running || editTarget?.status === "starting";
  const editValid = (editForm.name ?? "").trim().length > 0 && (editLive || editNetChoice === "direct" || (editNetChoice === "sub" ? !!editForm.proxy_source && !!editForm.proxy_node : !!(editForm.proxy_server ?? "").trim()));

  const runningList = identities.filter((it) => it.running || it.status === "starting");
  const proxyEnvs = identities.filter((it) => it.network_mode === "proxy");

  const coreBlock = <>
    <h4>代理内核（mihomo）</h4>
    <div className="proxy-core"><span className={`proxy-dot ${proxyCore?.found ? "ok" : "warn"}`} /><span>{proxyCore === null ? "正在检测…" : proxyCore.found ? <>已检测到 <code>{proxyCore.path}</code></> : "未检测到 mihomo 内核"}</span></div>
    <p className="hint">订阅节点依赖 mihomo 内核。可将 mihomo.exe 放入软件目录的 tools 文件夹，或手动指定路径；Clash Verge 自带的 mihomo 也会被自动识别。</p>
    <div className="settings-actions"><button className="secondary" onClick={loadProxy} disabled={!!subBusy}>重新检测</button><button className="secondary" onClick={pickCore} disabled={!!subBusy}>指定内核路径</button></div>
    {subBusy && <div className="form-progress">{subBusy}</div>}
  </>;

  const subBlock = <>
    <h4>代理订阅</h4>
    {proxySourceList.length === 0
      ? <p className="hint">暂无订阅。可导入本地 Clash 配置、订阅链接，或直接使用 Clash 客户端里的配置。</p>
      : <div className="sub-list">{proxySourceList.map((s) => <div className="sub-row" key={s.name}><div className="sub-info"><strong>{s.label}</strong><span>{s.nodes} 个节点 · {s.updated_at}</span></div><div className="row-actions"><button className="secondary" onClick={() => renameSource(s)} disabled={!!subBusy}>备注</button><button className="more-action danger-text" onClick={() => removeSource(s)} disabled={!!subBusy}>删除</button></div></div>)}</div>}
    <div className="settings-actions"><button className="secondary" onClick={() => importBy("file")} disabled={!!subBusy}>导入本地文件</button><button className="secondary" onClick={() => importBy("url")} disabled={!!subBusy}>订阅链接</button><button className="secondary" onClick={scanClash} disabled={!!subBusy}>扫描 Clash 配置</button></div>
  </>;

  const dataBlock = <>
    <h4>身份数据</h4>
    <p className="hint">身份包、订阅与代理配置都保存在同一个数据目录，迁移时整个复制即可。</p>
    <div className="data-line"><code>{dataInfo?.dir ?? "正在读取…"}</code></div>
    <div className="settings-actions"><button className="secondary" onClick={openDataFolder}>打开数据文件夹</button><button className="secondary" onClick={loadData}>刷新列表</button></div>
    <h4>备份与迁移</h4>
    <p className="hint">导出会打包全部环境（含保存的账号密码）、订阅、设置与启动记录；导入会覆盖同名文件，建议先停止所有浏览器。</p>
    <div className="settings-actions">
      <PendingButton className="secondary" onClick={exportAll} disabled={busy.size > 0} busy={busy.has("export-all")} idle="导出全部数据" pending="导出中…" />
      <PendingButton className="secondary" onClick={importAll} disabled={busy.size > 0} busy={busy.has("import-all")} idle="导入全部数据" pending="导入中…" />
    </div>
    {dataInfo && dataInfo.packs.length > 0
      ? <div className="sub-list">{dataInfo.packs.map((p) => <div className="sub-row" key={p.name}><div className="sub-info"><strong>{p.name}</strong><span>{formatSize(p.size)} · {formatStamp(p.modified)}</span></div><PendingButton className="secondary" onClick={() => importArchive(p.name)} disabled={busy.size > 0} busy={busy.has(`import-${p.name}`)} idle="导入" pending="导入中…" /></div>)}</div>
      : <p className="hint">还没有身份包。在环境编辑窗口点「导出身份」即可保存到此处。</p>}
  </>;

  const runtimeControls = <section className="edit-section">
    <h4>运行环境</h4>
    <p className="hint">优先复用本机已有 Python 并创建独立虚拟环境安装依赖，避免下载完整 Python 包；若未自动检测到，可手动选择 Python 目录或按指引安装。</p>
    {environment && <EnvChecks checks={environment.checks} pythonDetected={environment.python_detected} onAction={handleEnvAction} busy={runtimeBusy} />}
    <p className="hint">依赖安装会自动尝试国内 PyPI 镜像和系统代理；全部失败才会询问是否手动设置代理。</p>
    <div className="settings-actions">
      {environment?.python_detected
        ? <>
          {!environment.dependencies_ready && <button className="primary" disabled={runtimeBusy} onClick={() => setupLocalRuntime()}>一键安装依赖（复用本机 Python）</button>}
          <button className="secondary" disabled={runtimeBusy} onClick={() => browsePython("dir", true)}>选择其他 Python 目录</button>
        </>
        : <>
          <button className="primary" disabled={runtimeBusy} onClick={() => browsePython("dir", true)}>选择本地 Python 目录</button>
          <button className="secondary" disabled={runtimeBusy} onClick={() => browsePython("file", true)}>选择 python.exe</button>
        </>}
      <button className="secondary" onClick={() => { setShowSettings(false); setView("fonts"); }}>管理字体库</button>
      <button className="secondary" disabled={runtimeBusy} onClick={checkEnvironment}>重新检查</button>
      <button className="secondary" disabled={runtimeBusy || !!updateState?.busy} onClick={clearDownloadProxy}>清除下载代理，恢复自动检测</button>
    </div>
    <details open={manualOpen} onToggle={(e) => setManualOpen(e.currentTarget.open)}><summary>手动安装 Python / 指定本地目录</summary>
      <p className="hint">可手动选择或粘贴本机 Python 安装目录（或 python.exe 路径）。若已有依赖会直接启用；若缺少依赖，点击下方按钮会自动基于该 Python 创建独立环境并安装依赖。</p>
      <label className="edit-field">
        <span>Python 安装目录或 python.exe 路径</span>
        <div className="path-picker-row">
          <input value={pythonPath} onChange={(e) => setPythonPath(e.target.value)} placeholder="例如：C:\\Python312 或 C:\\…\\python.exe" disabled={runtimeBusy} />
          <button type="button" className="secondary" disabled={runtimeBusy} onClick={() => browsePython("dir", false)}>选择目录</button>
          <button type="button" className="secondary" disabled={runtimeBusy} onClick={() => browsePython("file", false)}>选择文件</button>
        </div>
      </label>
      <div className="settings-actions">
        <button className="primary" onClick={applyPython} disabled={runtimeBusy || !pythonPath.trim()}>使用此 Python（缺依赖时自动安装）</button>
      </div>
      <p className="hint">如果机器尚未安装 Python，可将以下命令复制到 PowerShell 执行安装：</p>
      <pre className="cmd-block">{guideText}</pre>
      <div className="settings-actions">
        <button className="secondary" onClick={copyGuide}>{copied ? "已复制" : "复制安装命令"}</button>
        <button className="secondary" disabled={runtimeBusy} onClick={() => setupRuntime("python")}>备用：下载独立运行时{environment?.python_size ? `（${formatSize(environment.python_size)}）` : ""}</button>
      </div>
    </details>
  </section>;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={APP_ICON} alt="" /><div><strong>Cacer</strong><span>隐私浏览工作台</span></div></div>
      <nav className="nav"><div className="nav-group-title">工作台</div><a className={`nav-item ${view === "overview" ? "active" : ""}`} onClick={() => setView("overview")}><Icon>⌂</Icon>总览</a><a className={`nav-item ${view === "environments" ? "active" : ""}`} onClick={() => setView("environments")}><Icon>▦</Icon>浏览器环境<span className="nav-count">{identities.length}</span></a><a className={`nav-item ${view === "proxy" ? "active" : ""}`} onClick={() => setView("proxy")}><Icon>⌁</Icon>代理管理</a><a className={`nav-item ${view === "extensions" ? "active" : ""}`} onClick={() => setView("extensions")}><Icon>⧩</Icon>扩展中心<span className="nav-count">{extItems.length}</span></a><a className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><Icon>◷</Icon>启动记录</a><div className="nav-group-title second">系统</div><a className={`nav-item ${view === "fonts" ? "active" : ""}`} onClick={() => setView("fonts")}><Icon>文</Icon>字体库</a><a className="nav-item" onClick={openSettings}><Icon>⚙</Icon>设置</a></nav>
      <button type="button" className={`sidebar-bottom ${environment && !environment.ready ? "service-warning" : ""}`} disabled={checkingEnvironment} onClick={checkEnvironment}
        title={environment?.checks.map(item => `${item.label}：${item.ok ? "正常" : "待处理"}`).join("\n") || "检查本机运行环境"}>
        <i className="health-dot"/><div><strong aria-live="polite">{checkingEnvironment ? "正在检测…" : environment?.ready ? "本地服务正常" : "需要检查环境"}</strong><span>Cacer {appVersion}{!checkingEnvironment && !environment?.ready && " · 点击检测"}</span></div>
      </button>
    </aside>
    <section className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>工作台</span><b>/</b><strong>{VIEW_LABEL[view]}</strong></div><div className="top-actions">{update?.available && <button className="icon-button update-button" title={`发现新版本 ${update.latest}`} onClick={() => setShowUpdate(true)}>⤓<i className="update-dot" /></button>}<button className="icon-button" title="刷新" onClick={() => refresh(true)}>↻</button><button className="icon-button" title="设置" onClick={openSettings}>⚙</button></div></header>
      <div className="content">
        {environment && !environment.ready && <div className="banner warning env-banner"><div className="env-banner-body"><div className="env-banner-head"><strong>运行环境未就绪</strong><button className="env-recheck" onClick={checkEnvironment} disabled={runtimeBusy}>重新检查</button></div><EnvChecks checks={environment.checks} pythonDetected={environment.python_detected} onAction={handleEnvAction} busy={runtimeBusy} /></div></div>}
        {error && <div className="banner error"><span>!</span><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
        {notice && <div className="banner success"><span>✓</span><span>{notice}</span></div>}
        {view === "fonts" && <>
          <div className="page-heading"><div><div className="eyebrow">FONT LIBRARY</div><h1>字体库</h1><p>按环境准备所需字体，已下载的字体可在所有环境中复用。</p></div><button className="secondary" onClick={loadFontPlan} disabled={runtimeBusy || fontLoading}>刷新索引</button></div>
          <section className="panel font-panel">
            <div className="grid">
              <label><span>按环境检查</span><select value={fontIdentity} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontIdentity(e.target.value); setFontCountry(""); setPendingLaunch(null); }}><option value="">选择环境…</option>{identities.map((it) => <option key={it.id} value={it.id}>{it.name || it.id} · {it.country} · {OS_LABELS[it.os] ?? it.os}</option>)}</select></label>
              <label><span>按国家 / 地区预下载</span><select value={fontCountry} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontCountry(e.target.value); setFontIdentity(""); setPendingLaunch(null); }}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{value ? label : "仅公共字体"}</option>)}</select></label>
            </div>
            <p className="hint">国家对应的语言只是推荐。选择已有环境后，还会检查浏览器界面语言和系统指纹实际需要的字体；英语环境也可能需要中日韩字体。预下载后，启动前会再检查一次。</p>
            {fontLoading && <div className="form-progress">正在读取环境的字体需求…</div>}
            {fontPlan?.development && <p className="hint">当前开发环境使用已安装引擎的字体。正式安装包提供分包索引与下载管理。</p>}
            {fontPlan && !fontPlan.development && <>
              <div className="font-summary"><strong>{fontPlan.packs.filter((pack) => pack.cached).length} / {fontPlan.packs.length} 个包已缓存</strong><span>当前缺少 {fontPlan.packs.filter((pack) => pack.required && !pack.cached).length} 个所需包 · 需下载 {formatSize(fontPlan.missing_size)}</span></div>
              <div className="settings-actions">
                <button className="primary" disabled={runtimeBusy || fontLoading || fontPlan.ready} onClick={() => setupRuntime("fonts", fontPlan.packs.filter((pack) => pack.required).map((pack) => pack.id))}>下载当前所需</button>
                <button className="secondary" disabled={runtimeBusy || fontLoading || !selectedFonts.length} onClick={() => setupRuntime("fonts", selectedFonts)}>下载勾选项</button>
                <button className="secondary" disabled={runtimeBusy || fontLoading || fontPlan.packs.every((pack) => pack.cached)} onClick={() => setupRuntime("fonts", fontPlan.packs.map((pack) => pack.id))}>全部下载（{formatSize(fontPlan.packs.filter((pack) => !pack.cached).reduce((sum, pack) => sum + pack.size, 0))}）</button>
                {pendingLaunch && <button className="primary" disabled={runtimeBusy || fontLoading || !fontIdentity} onClick={() => withBusy("font-launch", downloadAndLaunch)}>{fontPlan.ready ? "启动环境" : "下载所需并启动"}</button>}
              </div>
              <div className="sub-list">{fontPlan.packs.map((pack) => <label className="sub-row font-row" key={pack.id}>
                <input type="checkbox" checked={selectedFonts.includes(pack.id)} disabled={pack.cached || runtimeBusy || fontLoading} onChange={(e) => setSelectedFonts(e.target.checked ? [...selectedFonts, pack.id] : selectedFonts.filter((id) => id !== pack.id))} />
                <div className="sub-info"><strong>{pack.name}</strong><span>{pack.count ? `${pack.count} 个文件 · ` : ""}{formatSize(pack.size)} 下载 · {formatSize(pack.unpacked_size)} 解压</span></div>
                <span className={pack.cached ? "font-cached" : "font-missing"}>{pack.cached ? "已缓存" : pack.required ? "当前需要" : "可选"}</span>
              </label>)}</div>
            </>}
          </section>
          <section className="panel font-panel">{runtimeControls}</section>
        </>}
        {view === "overview" && <>
          <div className="page-heading"><div><div className="eyebrow">DASHBOARD</div><h1>总览</h1><p>查看运行状态与环境分布。</p></div><button className="primary large" onClick={openCreate}>＋ 新建环境</button></div>
          <section className="stats"><div className="stat-card"><span className="stat-icon purple">▦</span><div><span>全部环境</span><strong>{identities.length}</strong></div></div><div className="stat-card"><span className="stat-icon green">●</span><div><span>正在运行</span><strong>{running}</strong></div></div><div className="stat-card"><span className="stat-icon blue">⌁</span><div><span>已配置代理</span><strong>{proxyCount}</strong></div></div><div className="stat-card"><span className="stat-icon orange">✓</span><div><span>服务状态</span><strong className="status-text">{environment?.ready ? "正常" : "待检查"}</strong></div></div></section>
          <section className="panel panel-pad">
            <h3 className="block-title">正在运行的浏览器</h3>
            {runningList.length === 0
              ? <div className="empty-mini">当前没有运行中的浏览器环境。</div>
              : <div className="sub-list">{runningList.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.network_mode === "direct" ? "直连" : it.proxy_node ?? it.proxy_server ?? "代理"}</span></div><span className={`status ${it.status === "starting" ? "starting" : "online"}`}><i />{it.status === "starting" ? "启动中" : "运行中"}</span></div>)}</div>}
          </section>
          <section className="panel panel-pad">
            <h3 className="block-title">快速开始</h3>
            <div className="settings-actions"><button className="secondary" onClick={openCreate}>新建环境</button><button className="secondary" onClick={() => setView("proxy")}>管理代理订阅</button><button className="secondary" onClick={() => setView("history")}>查看启动记录</button></div>
          </section>
        </>}
        {view === "environments" && <>
          <div className="page-heading"><div><div className="eyebrow">ENVIRONMENT MANAGER</div><h1>浏览器环境</h1><p>管理独立身份、网络配置与浏览器运行状态。</p></div><button className="primary large" onClick={openCreate}>＋ 新建环境</button></div>
        <section className="panel"><div className="toolbar"><div className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索环境名称、国家或代理" /></div><div className="toolbar-right"><span className="result-count">共 {visible.length} 个环境</span>{!search.trim() && identities.length > 1 && <span className="drag-hint">拖动环境行可调整顺序</span>}</div></div>
          {visible.length === 0 ? <div className="empty"><img className="empty-mark" src={APP_ICON} alt="" /><h3>{identities.length ? "没有匹配的环境" : "开始创建第一个环境"}</h3><p>{identities.length ? "尝试更换搜索关键词。" : "为不同的浏览任务创建隔离的浏览器身份。"}</p>{!identities.length && <button className="primary" onClick={openCreate}>＋ 新建环境</button>}</div> : <div className="table-wrap"><table><thead><tr><th>环境</th><th>状态</th><th>设备</th><th>网络</th><th>地区 / 语言</th><th className="actions-head">操作</th></tr></thead><tbody>{visible.map((it) => <tr key={it.id} draggable={canDrag} className={dragId === it.id ? "row-dragging" : dragOverId === it.id && dragId !== it.id ? "row-drop-target" : undefined} onDragStart={(e) => startDrag(e, it.id)} onDragOver={(e) => overRow(e, it.id)} onDrop={(e) => dropRow(e, it.id)} onDragEnd={endDrag}><td><div className="profile-cell"><div className="country-avatar"><Flag country={it.country} size={26} /></div><div><strong>{it.name || it.id}</strong><span onMouseEnter={(e) => showNoteTip(e, it.note)} onMouseLeave={hideNoteTip}>{inlineNote(it.note) || `创建于 ${it.created_at?.slice(0, 10) ?? "—"}`}</span></div></div></td><td><span className={`status ${it.status === "starting" ? "starting" : it.running ? "online" : "offline"}`}><i />{it.status === "starting" ? "启动中" : it.running ? "运行中" : "已停止"}</span></td><td><span className="device"><b>{OS_ICONS[it.os] ?? "◈"}</b>{OS_LABELS[it.os] ?? it.os}</span></td><td><span className="network" title={it.proxy_node ?? it.proxy_server ?? undefined}><i className={it.network_mode === "direct" ? "direct" : "proxy"} />{it.network_mode === "direct" ? "直连" : it.proxy_node ?? "代理"}</span></td><td><span className="locale"><Flag country={it.country} size={17} /> {it.country || "自动"}<small>{it.languages?.[0] ?? it.locale}</small></span></td><td><div className="table-actions">{it.running || it.status === "starting" ? <button className="action stop-action" disabled={busy.has(`stop-${it.id}`) || busy.has(`launch-${it.id}`)} aria-busy={busy.has(`stop-${it.id}`)} onClick={() => withBusy(`stop-${it.id}`, () => stopIdentity(it.id))}><ButtonLabel busy={busy.has(`stop-${it.id}`)} idle={it.status === "starting" ? "取消" : "停止"} pending={it.status === "starting" ? "取消中…" : "停止中…"} /></button> : <button className="action launch-action" disabled={busy.has(`launch-${it.id}`) || busy.has(`stop-${it.id}`)} aria-busy={busy.has(`launch-${it.id}`)} onClick={() => withBusy(`launch-${it.id}`, () => launchPrepared(it.id))}><ButtonLabel busy={busy.has(`launch-${it.id}`)} idle="启动" pending="启动中…" /></button>}<button className="more-action" onClick={() => openEdit(it)}>编辑</button><button className="more-action danger-text" disabled={it.running} onClick={() => remove(it)}>删除</button></div></td></tr>)}</tbody></table></div>}
        </section>
        </>}
        {view === "proxy" && <>
          <div className="page-heading"><div><div className="eyebrow">PROXY MANAGER</div><h1>代理管理</h1><p>管理 mihomo 内核与 Clash 订阅，为每个环境分配独立出口。</p></div></div>
          <section className="panel panel-pad">{coreBlock}</section>
          <section className="panel panel-pad">{subBlock}</section>
          <section className="panel panel-pad">
            <h3 className="block-title">环境代理分配</h3>
            {proxyEnvs.length === 0
              ? <div className="empty-mini">还没有环境使用代理。编辑环境时可在「网络方式」中选择订阅节点。</div>
              : <div className="sub-list">{proxyEnvs.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.proxy_node ?? it.proxy_server ?? "代理"}{it.proxy_source ? ` · ${it.proxy_source}` : ""}</span></div><span className={`status ${it.running ? "online" : "offline"}`}><i />{it.running ? "运行中" : "已停止"}</span></div>)}</div>}
          </section>
        </>}
        {view === "extensions" && <>
          <div className="page-heading">
            <div><div className="eyebrow">EXTENSION CENTER</div><h1>扩展中心</h1><p>从 Firefox 官方商店安装扩展；安装后所有环境默认启用，可在环境编辑中按需关闭。</p></div>
            <PendingButton className="secondary" onClick={importExtension} disabled={!!extBusy} busy={extBusy === "import"} idle="导入本地 XPI" pending="导入中…" />
          </div>
          <section className="panel panel-pad">
            <h3 className="block-title">搜索 Firefox 扩展</h3>
            <div className="ext-search">
              <input value={extQuery} onChange={(e) => setExtQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") searchExtensions(); }} placeholder="例如：ublock、沉浸式翻译、LastPass…" />
              <PendingButton className="primary" onClick={searchExtensions} disabled={!!extBusy || !extQuery.trim()} busy={extBusy === "search"} idle="搜索" pending="搜索中…" />
            </div>
            <p className="hint">数据来自 addons.mozilla.org（Firefox 官方扩展商店）。本内核是 Camoufox（Firefox），Chrome / Edge 商店的插件无法安装。</p>
            {extSearched && (extResults.length === 0
              ? <div className="empty-mini">没有找到匹配的扩展。</div>
              : <div className="ext-grid">{extResults.map((item) => <div className="ext-card" key={item.slug}>
                {item.icon ? <img className="ext-icon" src={item.icon} alt="" /> : <span className="ext-icon ext-fallback">{item.name.slice(0, 1)}</span>}
                <div className="ext-body">
                  <strong className="ext-name">{item.name}</strong>
                  <span className="ext-summary">{item.summary || "暂无简介"}</span>
                  <span className="ext-meta">v{item.version}{item.rating ? ` · ${item.rating} 分` : ""}{item.users ? ` · ${formatUsers(item.users)} 用户` : ""}</span>
                </div>
                <div className="ext-foot">{item.installed ? <span className="ext-badge">已安装</span> : <PendingButton className="primary" disabled={!!extBusy} onClick={() => installExtension(item.slug)} busy={extBusy === `install-${item.slug}`} idle="安装" pending="安装中…" />}</div>
              </div>)}</div>)}
          </section>
          <section className="panel panel-pad">
            <h3 className="block-title">已安装扩展</h3>
            <p className="hint">安装后默认在所有环境启用。每个环境的开关在「浏览器环境 → 编辑 → 浏览器扩展」里，只影响下一次启动，不会重建环境指纹。</p>
            {extItems.length === 0
              ? <div className="empty-mini">还没有安装扩展。</div>
              : <div className="ext-grid">{extItems.map((item) => <div className="ext-card" key={item.slug}>
                {item.icon ? <img className="ext-icon" src={item.icon} alt="" /> : <span className="ext-icon ext-fallback">{item.name.slice(0, 1)}</span>}
                <div className="ext-body">
                  <strong className="ext-name">{item.name}</strong>
                  <span className="ext-summary">{item.summary || "暂无简介"}</span>
                  <span className="ext-meta">v{item.version} · {EXT_SOURCE_LABEL[item.source] ?? item.source}</span>
                </div>
                <div className="ext-foot">{item.removable ? <PendingButton className="more-action danger-text" disabled={!!extBusy} onClick={() => removeExtension(item)} busy={extBusy === `remove-${item.slug}`} idle="卸载" pending="卸载中…" /> : <span className="ext-badge">内置</span>}</div>
              </div>)}</div>}
          </section>
        </>}
        {view === "history" && <>
          <div className="page-heading"><div><div className="eyebrow">LAUNCH LOG</div><h1>启动记录</h1><p>记录每次环境启动、停止与窗口关闭事件。</p></div><button className="secondary" onClick={loadHistory}>刷新</button></div>
          <section className="panel">
            {history.length === 0
              ? <div className="empty"><div className="empty-mark">◷</div><h3>暂无启动记录</h3><p>启动任意环境后，这里会显示时间、网络方式与事件。</p></div>
              : <div className="table-wrap"><table><thead><tr><th>时间</th><th>环境</th><th>事件</th><th>网络</th></tr></thead><tbody>{history.map((item, index) => <tr key={`${item.at}-${item.id}-${index}`}><td>{item.at}</td><td><div className="profile-cell"><div><strong>{item.name || item.id}</strong><span>{item.id}</span></div></div></td><td><span className={`status ${item.event === "launch" ? "online" : "offline"}`}><i />{EVENT_LABEL[item.event] ?? item.event}</span></td><td>{item.network ?? "—"}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
      </div>
    </section>

    {runtimeBusy && downloadState && <div className="download-toast" role="status">
      <div className="download-toast-head"><strong>正在准备运行资源</strong><button className="icon-button" title="取消下载" onClick={() => cancelRuntime().catch((e) => setError(String(e)))}>×</button></div>
      <p>{downloadState.message}</p>
      {downloadState.total > 0 && <><progress max={downloadState.total} value={downloadState.downloaded} /><span>{formatSize(downloadState.downloaded)} / {formatSize(downloadState.total)}</span></>}
    </div>}

    {showCreate && <Modal title="新建浏览器环境" closeDisabled={busy.has("create")} onClose={() => { if (!busyRef.current.has("create")) setShowCreate(false); }}><div className="form-intro">创建后将生成一套稳定、隔离的浏览器身份配置。</div>{error && <div className="form-error">{error}</div>}{busy.has("create") && <div className="form-progress">正在生成隔离指纹，请稍候，完成后自动关闭…</div>}<div className="grid"><label><span>环境名称 <em>*</em></span><input value={form.name} placeholder="例如：法国小店-A" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label><span>备注</span><textarea rows={3} value={form.note} placeholder="例如：电商账号专用（支持换行）" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label><label><span>设备系统</span><select value={form.os ?? ""} onChange={(e) => setForm({ ...form, os: e.target.value || null })}>{OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label><label><span>国家 / 地区</span><select value={form.country ?? ""} onChange={(e) => setForm({ ...form, country: e.target.value || null })}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small className="field-hint">语言、时区与设备指纹将自动跟随国家。</small></label><label className="wide"><span>浏览器界面语言</span><select value={form.ui_locale ?? "zh-CN"} onChange={(e) => setForm({ ...form, ui_locale: e.target.value })}><option value="zh-CN">中文（菜单显示中文）</option><option value="">跟随环境语言（一致性最高）</option></select><small className="field-hint">仅影响浏览器菜单与对话框的显示，不会改变网站识别到的语言和地区。选择「跟随环境语言」时，日期与数字格式也会与当地完全一致。</small></label><label className="wide"><span>内存缓存</span><div className="seg">{([["on", "开启（推荐）"], ["off", "关闭"]] as const).map(([value, label]) => <button type="button" key={value} className={(form.memory_cache === false) === (value === "off") ? "seg-on" : "seg-off"} onClick={() => setForm({ ...form, memory_cache: value === "on" })}>{label}</button>)}</div><small className="field-hint">允许浏览器在内存中复用已缓存的资源，减少重复下载。</small></label><label className="wide"><span>网络方式</span><div className="seg">{([["direct", "直连"], ["sub", "订阅节点"], ["custom", "手动代理"]] as const).map(([value, label]) => <button type="button" key={value} className={netChoice === value ? "seg-on" : "seg-off"} onClick={() => setNetChoice(value)}>{label}</button>)}</div></label>
      {netChoice === "sub" && <>
        <label className="wide"><span>代理订阅</span><select value={form.proxy_source ?? ""} onChange={(e) => chooseSubSource(e.target.value, false)}><option value="">选择订阅…</option>{proxySourceList.map((s) => <option key={s.name} value={s.name}>{s.label}（{s.nodes} 个节点）</option>)}</select>{!proxySourceList.length && <small className="field-hint">还没有订阅，请先在「代理管理」中导入。</small>}</label>
        <label className="wide"><span>节点</span><select value={form.proxy_node ?? ""} onChange={(e) => setForm({ ...form, proxy_node: e.target.value || null })} disabled={!form.proxy_source}><option value="">{form.proxy_source ? "选择节点…" : "请先选择订阅"}</option>{subNodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.type ? ` · ${n.type}` : ""}</option>)}</select></label>
      </>}
      {netChoice === "custom" && <label className="wide"><span>代理服务器</span><input value={form.proxy_server ?? ""} placeholder="127.0.0.1:8080（默认 HTTP）" onChange={(e) => setForm({ ...form, proxy_server: e.target.value })} /></label>}</div><div className="modal-footer"><button className="secondary" disabled={busy.has("create")} onClick={() => setShowCreate(false)}>取消</button><button className="primary" disabled={!valid || busy.has("create")} aria-busy={busy.has("create")} onClick={create}><ButtonLabel busy={busy.has("create")} idle="生成环境" pending="生成中…" /></button></div></Modal>}
    {showSettings && <Modal title="设置" onClose={() => setShowSettings(false)}>
      {error && <div className="form-error">{error}</div>}
      <details className="edit-section"><summary>关于 Cacer</summary><p>版本 {appVersion}</p><p>项目仓库：<a href="https://github.com/baseless1119/CacerBrowser" target="_blank" rel="noreferrer">github.com/baseless1119/CacerBrowser</a></p><p>Cacer 自定义软件许可 · 原创部分由著作权人保留全部权利。未经书面许可，禁止以商业目的重新打包或分发。第三方组件适用各自许可。</p></details>
      {runtimeControls}
      <section className="edit-section">{dataBlock}</section>
    </Modal>}
    {showUpdate && update && <Modal title="发现新版本" onClose={() => { if (!updateState?.busy) setShowUpdate(false); }}>
      {error && <div className="form-error">{error}</div>}
      <section className="edit-section">
        <div className="update-versions"><span>当前版本 <strong>{update.current}</strong></span><span>最新版本 <strong>{update.latest}</strong></span><span>安装包 {formatSize(update.size)}</span></div>
        {update.notes && <pre className="update-notes">{update.notes}</pre>}
        <p className="hint">下载会自动尝试多个 GitHub 镜像，通过校验后启动安装。安装向导中可修改安装目录，现有环境、订阅与设置都会保留。</p>
        {updateState && <div className="form-progress" role="status">{updateState.message}{updateState.total > 0 && <> · {formatSize(updateState.downloaded)} / {formatSize(updateState.total)}<progress max={updateState.total} value={updateState.downloaded} /></>}</div>}
      </section>
      <div className="modal-footer">
        {updateState?.busy
          ? <button className="secondary" onClick={() => cancelUpdate().catch((e) => setError(String(e)))}>取消下载</button>
          : <><button className="secondary" onClick={() => setShowUpdate(false)}>稍后</button><button className="primary" onClick={() => startUpdate()}>下载并安装</button></>}
      </div>
    </Modal>}
    {showProxy && <Modal title="下载线路不可用" onClose={() => setShowProxy(false)}>
      {error && <div className="form-error">{error}</div>}
      <section className="edit-section">
        {proxyStep === "ask"
          ? <p className="hint">已依次尝试所有内置 GitHub 镜像和系统代理，仍无法下载。是否设置一个代理后重试？</p>
          : <>
            <p className="hint">请填写可用的 HTTP / SOCKS5 代理地址，保存后会立即重试下载。</p>
            <label className="edit-field"><span>下载代理</span><input autoFocus value={proxyValue} onChange={(e) => setProxyValue(e.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" /></label>
          </>}
      </section>
      <div className="modal-footer">
        <button className="secondary" onClick={() => { proxyRetry.current = null; setShowProxy(false); }}>取消</button>
        <button className="secondary" onClick={() => applyProxy(true)}>清除代理并自动重试</button>
        {proxyStep === "ask"
          ? <button className="primary" onClick={() => setProxyStep("input")}>设置代理</button>
          : <button className="primary" disabled={!proxyValue.trim()} onClick={() => applyProxy()}>保存并重试</button>}
      </div>
    </Modal>}
    {showClash && <Modal title="扫描到的 Clash 配置" onClose={() => setShowClash(false)}>
      {error && <div className="form-error">{error}</div>}
      {localClashConfigs.length === 0
        ? <p className="hint">没有扫描到包含节点的 Clash 配置。</p>
        : <>
          <p className="hint">共 {localClashConfigs.length} 个配置，可修改备注名后逐个导入，或一次全部导入。</p>
          <div className="sub-list clash-list">{localClashConfigs.map((c) => <div className="sub-row" key={c.path}>
            <input className="clash-name" value={clashLabels[c.path] ?? ""} placeholder={c.name} onChange={(e) => setClashLabels({ ...clashLabels, [c.path]: e.target.value })} disabled={!!subBusy} />
            <span className="clash-meta">{c.nodes} 个节点</span>
            <button className="secondary" onClick={() => importFromClash(c)} disabled={!!subBusy}>导入</button>
          </div>)}</div>
          {subBusy && <div className="form-progress">{subBusy}</div>}
        </>}
      <div className="modal-footer"><button className="secondary" onClick={() => setShowClash(false)} disabled={!!subBusy}>关闭</button><button className="primary" onClick={importAllClash} disabled={!!subBusy || localClashConfigs.length === 0}>全部导入</button></div>
    </Modal>}
    {failedTask && <Modal title="安装失败" onClose={() => setFailedTask(null)}>
      <section className="edit-section">
        {failedTask === "local-python" ? <>
          <p className="hint">重试后仍无法通过 pip 安装依赖。可在 PowerShell 中手动执行以下命令安装，或改用内置依赖的独立运行时。</p>
          <pre className="cmd-block">{guideText}</pre>
        </> : failedTask === "python" ? <>
          <p className="hint">重试后仍无法下载运行环境。可在 PowerShell 中手动执行以下命令安装，完成后回到主界面点「重新检查」。</p>
          <pre className="cmd-block">{guideText}</pre>
        </> : <p className="hint">字体下载失败，请检查网络后在「字体库」页面重新尝试。</p>}
      </section>
      <div className="modal-footer">
        {(failedTask === "python" || failedTask === "local-python") && <button className="secondary" onClick={copyGuide}>{copied ? "已复制" : "复制安装命令"}</button>}
        {failedTask === "local-python" && <button className="secondary" onClick={() => { setFailedTask(null); void setupRuntime("python"); }}>改用独立运行时（备用）</button>}
        <button className="secondary" onClick={() => setFailedTask(null)}>关闭</button>
      </div>
    </Modal>}
    {editTarget && <Modal title="编辑环境" closeDisabled={editBusy} onClose={() => { if (!editBusy) setEditTarget(null); }}>{error && <div className="form-error" role="alert">{error}</div>}<section className="edit-section"><h4>身份指纹</h4><div className="fpinfo"><span><Flag country={editTarget.country} size={16} /> {editTarget.country || "自动地区"}</span><span>{OS_ICONS[editTarget.os]} {OS_LABELS[editTarget.os] ?? editTarget.os}</span><span>◷ {editTarget.timezone}</span><span>文 {editTarget.languages?.[0] ?? editTarget.locale}</span></div><p className="hint">设备指纹保持不变，以维持 Cookie 和登录状态的一致性。</p></section><section className="edit-section"><h4>基本信息</h4><div className="grid"><label><span>环境名称</span><input value={editForm.name ?? ""} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></label><label><span>备注</span><textarea rows={3} value={editForm.note ?? ""} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} /></label><label><span>设备系统</span><select value={editForm.os ?? ""} disabled={editLive} onChange={(e) => setEditForm({ ...editForm, os: e.target.value || null })}>{OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label><label><span>国家 / 地区</span><select value={editForm.country ?? ""} disabled={editLive} onChange={(e) => setEditForm({ ...editForm, country: e.target.value || null })}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wide"><span>浏览器界面语言</span><select value={editForm.ui_locale ?? ""} onChange={(e) => setEditForm({ ...editForm, ui_locale: e.target.value })}><option value="zh-CN">中文（菜单显示中文）</option><option value="">跟随环境语言（一致性最高）</option>{editForm.ui_locale && editForm.ui_locale !== "zh-CN" && <option value={editForm.ui_locale}>当前：{editForm.ui_locale}</option>}</select><small className="field-hint">仅影响浏览器菜单与对话框的显示，不会改变网站识别到的语言和地区。修改后下次启动生效。</small></label><label className="wide"><span>内存缓存</span><div className="seg">{([["on", "开启（推荐）"], ["off", "关闭"]] as const).map(([value, label]) => <button type="button" key={value} className={(editForm.memory_cache === false) === (value === "off") ? "seg-on" : "seg-off"} onClick={() => setEditForm({ ...editForm, memory_cache: value === "on" })}>{label}</button>)}</div><small className="field-hint">允许浏览器在内存中复用已缓存的资源，减少重复下载。修改后下次启动生效。</small></label></div></section><section className="edit-section"><h4>网络方式</h4><div className="seg">{([["direct", "直连"], ["sub", "订阅节点"], ["custom", "手动代理"]] as const).map(([value, label]) => <button type="button" disabled={editLive} key={value} className={editNetChoice === value ? "seg-on" : "seg-off"} onClick={() => setEditNetChoice(value)}>{label}</button>)}</div>
      {editNetChoice === "sub" && <div className="grid">
        <label><span>代理订阅</span><select value={editForm.proxy_source ?? ""} disabled={editLive} onChange={(e) => chooseSubSource(e.target.value, true)}><option value="">选择订阅…</option>{proxySourceList.map((s) => <option key={s.name} value={s.name}>{s.label}（{s.nodes} 个节点）</option>)}</select>{!proxySourceList.length && <small className="field-hint">还没有订阅，请先在「代理管理」中导入。</small>}</label>
        <label><span>节点</span><select value={editForm.proxy_node ?? ""} onChange={(e) => setEditForm({ ...editForm, proxy_node: e.target.value })} disabled={editLive || !editForm.proxy_source}><option value="">{editForm.proxy_source ? "选择节点…" : "请先选择订阅"}</option>{editSubNodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.type ? ` · ${n.type}` : ""}</option>)}</select></label>
      </div>}
      {editNetChoice === "custom" && <label className="edit-field"><span>代理服务器</span><input value={editForm.proxy_server ?? ""} disabled={editLive} placeholder="127.0.0.1:8080（默认 HTTP）" onChange={(e) => setEditForm({ ...editForm, proxy_server: e.target.value })} /></label>}<p className="hint">{editLive ? "浏览器运行中：名称、备注、界面语言、内存缓存和扩展开关会立即保存（语言、缓存与扩展下次启动生效）；设备指纹、国家与网络设置需先停止浏览器。" : "代理修改会在下次启动时生效，未写协议时按 HTTP 处理。"}</p></section><section className="edit-section"><h4>浏览器扩展</h4>{extItems.length === 0 ? <p className="hint">还没有安装扩展。可到左侧「扩展中心」从 Firefox 官方商店安装，安装后所有环境默认启用。</p> : <div className="ext-toggles">{extItems.map((item) => { const on = !(editForm.disabled_extensions ?? []).includes(item.slug); return <label className={`ext-toggle ${on ? "" : "off"}`} key={item.slug}><input type="checkbox" checked={on} onChange={(e) => toggleEditExtension(item.slug, e.target.checked)} /><span><strong>{item.name}</strong><small>v{item.version}{item.engine ? " · 引擎内置" : ""}</small></span></label>; })}</div>}<p className="hint">开关只在下一次启动时决定是否加载该扩展，不重建环境指纹，也不影响 Cookie、缓存与登录状态。</p></section><section className="edit-section"><h4>账号密码</h4><p className="hint">在浏览器内登录网站后，Firefox 会提示保存账号密码。凭据保存在本环境的配置文件中，「导出身份」时会一并打包，导入后可直接继续使用；地址栏打开 about:logins 可查看和管理。</p></section><div className="modal-footer edit-footer"><div className="edit-transfer-actions">
        <PendingButton className="secondary" onClick={exportCookiesCurrent} disabled={editBusy} busy={busy.has(`cookies-${editTarget.id}`)} idle="导出 Cookie" pending="导出中…" />
        <PendingButton className="secondary" onClick={exportCurrent} disabled={editLive || editBusy} busy={busy.has(`export-${editTarget.id}`)} idle="导出身份" pending="导出中…" />
        <PendingButton className="secondary" onClick={cloneEnvironment} disabled={editLive || editBusy} busy={busy.has(`clone-${editTarget.id}`)} idle="复制为新环境" pending="复制中…" />
      </div><div className="edit-save-actions"><button className="secondary" disabled={editBusy} onClick={() => setEditTarget(null)}>取消</button>
        <PendingButton className="primary" disabled={editBusy || !editValid} busy={busy.has(`edit-${editTarget.id}`)} onClick={saveEdit} idle="保存修改" pending="保存中…" />
      </div></div></Modal>}
    {noteTip && <div className="note-tip" role="tooltip" style={{ left: noteTip.x, top: noteTip.y, transform: noteTip.above ? "translateY(calc(-100% - 8px))" : "none" }}>{noteTip.text}</div>}
  </main>;
}
