import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  ClashConfig, CreateRequest, DataOverview, EditRequest, ExtensionItem, ExtensionSearchResult, HistoryItem, Identity, ProxyNode, ProxySource,
  cancelRuntime, installRuntime, runtimeStatus, setupLocalPython, pickPythonPath, pickDialog, revealPath, type RuntimeStatus,
  checkUpdate, downloadUpdate, updateStatus, cancelUpdate, installUpdate, type UpdateInfo, type UpdateStatus,
  saveDownloadSettings, fontOverview, type FontOverview,
  clashConfigs, cloneIdentity, createIdentity, dataOverview, deleteIdentity, editIdentity, environmentCheck,
  exportAllData, exportCookies, exportPack, extImport, extInstall, extList, extRemove, extSearch, importAllData, importPack, launchHistory, launchIdentity, listIdentities, openDataDir,
  proxyDelete, proxyImport, proxyNodes, proxyRename, proxySetCore, proxySources, rebuildIdentity, reorderIdentities, stopIdentity, type EnvironmentCheck,
} from "./api";
import {
  ConfirmDialog, MessageDialog, PromptDialog, ToastHost, copyText,
  type ConfirmOptions, type DialogTone, type MessageOptions, type PromptOptions, type ToastItem,
} from "./Dialog";
import Flag from "./Flag";
import InfoTip from "./InfoTip";
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

function safeFileStem(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|\.+$/g, "").trim();
  return cleaned || "identity";
}

function emptyForm(): CreateRequest {
  return { name: "", note: "", os: "", country: "", network: "direct", ui_locale: "zh-CN", memory_cache: true };
}

function inlineNote(note: string): string {
  return note.replace(/\s*\n+\s*/g, " ").trim();
}

function cleanError(err: unknown): string {
  const text = String(err ?? "").trim();
  return text.replace(/^Error:\s*/i, "") || "操作失败";
}

function Icon({ children }: { children: ReactNode }) { return <span className="nav-icon">{children}</span>; }

function SectionTitle({ children, tip }: { children: ReactNode; tip?: string }) {
  return <div className="section-title-row"><h4>{children}</h4>{tip && <InfoTip text={tip} />}</div>;
}

function FieldLabel({ children, tip, required }: { children: ReactNode; tip?: string; required?: boolean }) {
  return <span className="field-label-row"><span>{children}{required && <em> *</em>}</span>{tip && <InfoTip text={tip} />}</span>;
}

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

/// Top-layer runtime progress card so progress stays visible above open modals.
function DownloadProgress({
  state,
  onCancel,
}: {
  state: RuntimeStatus;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el) return;
    try { el.showPopover?.(); } catch { /* fallback */ }
    return () => { try { el.hidePopover?.(); } catch { /* ignore */ } };
  }, []);

  return (
    <div
      ref={ref}
      // @ts-expect-error Popover places the progress card in the top layer above modals
      popover="manual"
      className="download-toast"
      role="status"
    >
      <div className="download-toast-head">
        <strong>正在准备运行资源</strong>
        <button className="icon-button" title="取消" onClick={onCancel}>×</button>
      </div>
      <p>{state.message}</p>
      {state.total > 0 && (
        <>
          <progress max={state.total} value={state.downloaded} />
          <span>{formatSize(state.downloaded)} / {formatSize(state.total)}</span>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentCheck | null>(null);
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
  const [checkingUpdate, setCheckingUpdate] = useState(false);
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

  // Dedicated top-layer dialog & toast system (never obscured by modals).
  const [messageModal, setMessageModal] = useState<{ options: MessageOptions; resolve: () => void } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [promptModal, setPromptModal] = useState<{ options: PromptOptions; resolve: (values: Record<string, string> | null) => void } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);

  function showToast(text: string, tone: DialogTone = "success") {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3600);
  }
  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }
  function showMessage(options: MessageOptions): Promise<void> {
    return new Promise((resolve) => setMessageModal({ options, resolve }));
  }
  function showError(err: unknown, title = "操作失败") {
    void showMessage({ tone: "error", title, message: cleanError(err) });
  }
  function showConfirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => setConfirmModal({ options, resolve }));
  }
  function showPrompt(options: PromptOptions): Promise<Record<string, string> | null> {
    return new Promise((resolve) => setPromptModal({ options, resolve }));
  }

  const hasActive = identities.some((it) => it.running || it.status === "starting");

  useEffect(() => {
    checkEnvironment();
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
    if (view === "proxy") loadProxy();
    if (view === "extensions") loadExtensions();
    if (view === "history") loadHistory();
    if (view === "overview" || view === "proxy") loadData();
  }, [view]);
  useEffect(() => {
    const block = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  function refresh(afterMutation = false): Promise<void> {
    if (!environmentRef.current?.ready) return Promise.resolve();
    if (refreshRequest.current) {
      if (afterMutation) refreshQueued.current = true;
      return refreshRequest.current;
    }
    refreshQueued.current = true;
    refreshRequest.current = (async () => {
      while (refreshQueued.current) {
        refreshQueued.current = false;
        try { setIdentities(await listIdentities()); }
        catch (e) { showToast(cleanError(e), "error"); }
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
      if (result.ready) { await refresh(true); await loadExtensions(); }
      return result;
    } catch (e) {
      setEnvironment(null);
      environmentRef.current = null;
      showError(e, "环境检查失败");
      return null;
    } finally {
      setCheckingEnvironment(false);
    }
  }

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
      const retry = proxyRetry.current;
      proxyRetry.current = null;
      retry?.(proxy);
    } catch (e) { showError(e, "代理格式无效"); }
  }
  async function clearDownloadProxy() {
    try {
      await saveDownloadSettings({ proxy: "", mirror: "" });
      showToast("已清除下载代理，将自动检测系统代理");
    } catch (e) { showError(e); }
  }

  async function setupRuntime(kind: "python" | "fonts", fontIds: string[] = [], proxyOverride?: string): Promise<boolean> {
    if (runtimeBusyRef.current) return false;
    runtimeBusyRef.current = true;
    setRuntimeBusy(true);
    setDownloadState({ busy: true, message: "正在准备", downloaded: 0, total: 0 });
    const timer = window.setInterval(() => runtimeStatus().then(setDownloadState).catch(() => {}), 500);
    try {
      await installRuntime(kind, proxyOverride ?? "", fontIds);
      if (kind === "fonts") await loadFontPlan();
      await checkEnvironment();
      showToast(kind === "python" ? "独立 Python 与依赖已准备完成" : "浏览器字体已准备完成");
      return true;
    } catch (e) {
      const message = cleanError(e);
      if (message.includes("已取消")) {
        showToast("已取消下载", "info");
      } else if (!message.includes(DOWNLOAD_ROUTES_FAILED)) {
        showError(message, kind === "python" ? "运行时安装失败" : "字体下载失败");
      } else if (proxyOverride !== undefined) {
        setCopied(false);
        setFailedTask(kind);
      } else {
        void offerProxy((retryProxy) => { void setupRuntime(kind, fontIds, retryProxy); });
      }
      return false;
    } finally {
      window.clearInterval(timer);
      runtimeBusyRef.current = false;
      setRuntimeBusy(false);
      setDownloadState(null);
    }
  }

  async function manualCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const info = await checkUpdate();
      setUpdate(info);
      if (info.available) {
        setShowSettings(false);
        setShowUpdate(true);
      } else {
        showToast(`当前已是最新版本（v${info.current}）`, "info");
      }
    } catch (e) {
      showError(e, "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function startUpdate(proxyRetried = false) {
    if (updateBusy.current || !update) return;
    updateBusy.current = true;
    setUpdateState({ busy: true, message: "正在准备下载", downloaded: 0, total: update.size });
    const timer = window.setInterval(() => updateStatus().then(setUpdateState).catch(() => {}), 500);
    try {
      await downloadUpdate();
      window.clearInterval(timer);
      setUpdateState({ busy: true, message: "下载完成，正在验证并启动安装程序…", downloaded: update.size, total: update.size });
      await installUpdate();
      showToast("安装程序已启动，Cacer 即将退出完成更新", "info");
    } catch (e) {
      const message = cleanError(e);
      if (message.includes(DOWNLOAD_ROUTES_FAILED)) {
        if (proxyRetried) showError("重试后仍无法下载更新包，请检查网络或稍后重试。", "更新失败");
        else void offerProxy(() => { void startUpdate(true); });
      } else {
        showError(message, "更新失败");
      }
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
    } catch (e) {
      if (request === fontRequest.current) { setFontPlan(null); showError(e, "读取字体索引失败"); }
    } finally {
      if (request === fontRequest.current) setFontLoading(false);
    }
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
    setDownloadState({ busy: true, message: "正在检查本机 Python…", downloaded: 0, total: 0 });
    const timer = window.setInterval(() => runtimeStatus().then(setDownloadState).catch(() => {}), 400);
    try {
      await setupLocalPython(customPath, proxyOverride ?? "");
      await checkEnvironment();
      showToast("已复用本机 Python 完成依赖配置");
      return true;
    } catch (e) {
      const message = cleanError(e);
      if (message.includes("已取消")) {
        showToast("已取消安装", "info");
      } else if (!message.includes(DOWNLOAD_ROUTES_FAILED)) {
        showError(message, "配置 Python 失败");
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
    try {
      const chosen = await pickPythonPath(kind);
      if (!chosen) return;
      setPythonPath(chosen);
      if (autoSetup) await setupLocalRuntime(chosen);
    } catch (e) {
      showError(e, "无法打开选择窗口");
    }
  }

  async function applyPython() {
    if (!pythonPath.trim()) return;
    await setupLocalRuntime(pythonPath);
  }

  async function launchPrepared(id: string) {
    if (!environmentRef.current?.ready) {
      void showMessage({ tone: "warning", title: "运行环境未就绪", message: "请先完成 Python 依赖配置，再启动浏览器环境。" });
      return;
    }
    const plan = await fontOverview(id);
    if (!plan.ready) {
      setFontIdentity(id); setFontCountry(""); setFontPlan(plan);
      setSelectedFonts(plan.packs.filter((pack) => pack.required && !pack.cached).map((pack) => pack.id));
      setPendingLaunch(id); setView("fonts");
      showToast("该环境缺少所需字体，请确认后下载并启动", "info");
      return;
    }
    await launchIdentity(id);
  }

  const guideText = environment?.manual_commands ?? "正在读取安装命令…";
  function handleEnvAction(action: EnvCardAction) {
    if (action === "engine") {
      void showMessage({ tone: "warning", title: "浏览器引擎缺失", message: "浏览器引擎随安装包提供，请重新运行当前版本的安装程序修复。" });
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
    await copyText(guideText);
    setCopied(true);
    showToast("安装命令已复制到剪贴板");
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function withBusy<T>(key: string, op: () => Promise<T>, errorTitle = "操作失败") {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      await op();
      await refresh(true);
    } catch (e) {
      showError(e, errorTitle);
      await refresh(true);
    } finally {
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
    } catch (e) { showError(e, "读取代理配置失败"); return []; }
  }

  async function loadNodes(source: string, forEdit: boolean) {
    const slot = forEdit ? "edit" : "create";
    const request = ++nodeRequests.current[slot];
    const updateNodes = forEdit ? setEditSubNodes : setSubNodes;
    updateNodes([]);
    if (!source) return;
    try {
      const result = await proxyNodes(source);
      if (request === nodeRequests.current[slot]) updateNodes(result.nodes);
    } catch (e) {
      if (request === nodeRequests.current[slot]) showError(e, "读取节点失败");
    }
  }

  async function scanClash() {
    setSubBusy("正在扫描 Clash 配置…");
    try {
      const configs = (await clashConfigs()).configs;
      setLocalClashConfigs(configs);
      setClashLabels(Object.fromEntries(configs.map((c) => [c.path, c.name])));
      if (!configs.length) {
        showToast("未扫描到包含节点的 Clash 配置", "info");
      } else {
        setShowClash(true);
      }
    } catch (e) { showError(e, "扫描失败"); }
    finally { setSubBusy(null); }
  }

  async function loadData() {
    try { setDataInfo(await dataOverview()); }
    catch (e) { showError(e, "读取数据目录失败"); }
  }
  async function loadHistory() {
    if (!environmentRef.current?.ready) return;
    try { setHistory((await launchHistory(80)).items); }
    catch (e) { showError(e, "读取启动记录失败"); }
  }
  async function loadExtensions() {
    if (!environmentRef.current?.ready) return;
    try { setExtItems((await extList()).extensions); }
    catch (e) { showError(e, "读取扩展列表失败"); }
  }

  function searchExtensions() {
    const query = extQuery.trim();
    if (!query || extBusy) return;
    setExtBusy("search");
    extSearch(query, 20)
      .then((data) => { setExtResults(data.results); setExtSearched(true); })
      .catch((e) => showError(e, "搜索扩展失败"))
      .finally(() => setExtBusy(null));
  }
  function installExtension(slug: string) {
    setExtBusy(`install-${slug}`);
    extInstall(slug)
      .then(async (item) => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === slug ? { ...result, installed: true } : result));
        showToast(`已安装「${item.name}」`);
      })
      .catch((e) => showError(e, "安装扩展失败"))
      .finally(() => setExtBusy(null));
  }
  async function importExtension(mode: "file" | "dir") {
    if (extBusy) return;
    try {
      const chosen = await pickDialog(mode === "file"
        ? { kind: "open_file", title: "选择 Firefox 扩展包", filter: "扩展安装包 (*.xpi;*.zip)|*.xpi;*.zip|所有文件 (*.*)|*.*", defaultDir: "downloads" }
        : { kind: "open_dir", title: "选择已解压的扩展文件夹" });
      if (!chosen) return;
      setExtBusy("import");
      const item = await extImport(chosen);
      await loadExtensions();
      showToast(`已导入扩展「${item.name}」`);
    } catch (e) {
      showError(e, "导入扩展失败");
    } finally {
      setExtBusy(null);
    }
  }
  async function removeExtension(item: ExtensionItem) {
    const ok = await showConfirm({
      title: "卸载扩展",
      message: `确定卸载「${item.name}」吗？卸载后所有环境都不再加载。`,
      confirmLabel: "卸载",
      danger: true,
    });
    if (!ok) return;
    setExtBusy(`remove-${item.slug}`);
    extRemove(item.slug)
      .then(async () => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === item.slug ? { ...result, installed: false } : result));
        showToast(`已卸载「${item.name}」`);
      })
      .catch((e) => showError(e, "卸载失败"))
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

  function openDataFolder() { openDataDir().catch((e) => showError(e)); }
  function openSettings() { setShowSettings(true); loadData(); }
  function openCreate() {
    if (busyRef.current.has("create")) return;
    loadNodes("", false);
    setForm(emptyForm());
    setNetChoice("direct");
    setSubNodes([]);
    setShowCreate(true);
    loadProxy();
  }
  function chooseSubSource(source: string, forEdit: boolean) {
    if (forEdit) setEditForm({ ...editForm, proxy_source: source, proxy_node: "" });
    else setForm({ ...form, proxy_source: source || null, proxy_node: null });
    loadNodes(source, forEdit);
  }
  async function doImport(kind: "file" | "url", value: string, label = "") {
    setSubBusy("正在导入订阅…");
    try {
      const result = await proxyImport(kind, value, "", label);
      await loadProxy();
      showToast(`已导入「${result.label}」（${result.count} 个节点）`);
    } catch (e) { showError(e, "导入订阅失败"); }
    finally { setSubBusy(null); }
  }
  async function importBy(kind: "file" | "url") {
    if (kind === "file") {
      try {
        const chosen = await pickDialog({
          kind: "open_file",
          title: "选择 Clash 配置文件",
          filter: "Clash 配置 (*.yaml;*.yml)|*.yaml;*.yml|所有文件 (*.*)|*.*",
          defaultDir: "downloads",
        });
        if (!chosen) return;
        await doImport("file", chosen, "");
      } catch (e) { showError(e, "选择文件失败"); }
      return;
    }
    const result = await showPrompt({
      title: "导入订阅链接",
      fields: [
        { key: "url", label: "Clash 订阅链接（http / https）", placeholder: "https://…", required: true },
        { key: "label", label: "备注名（选填）", placeholder: "留空自动命名" },
      ],
      confirmLabel: "导入",
    });
    if (!result?.url) return;
    await doImport("url", result.url, result.label ?? "");
  }
  function importFromClash(config: ClashConfig) {
    void doImport("file", config.path, (clashLabels[config.path] ?? config.name).trim());
  }
  async function importAllClash() {
    if (!localClashConfigs.length) return;
    try {
      const total = localClashConfigs.length;
      for (let index = 0; index < total; index += 1) {
        const config = localClashConfigs[index];
        setSubBusy(`正在导入 ${index + 1}/${total}：${config.name}`);
        await proxyImport("file", config.path, "", (clashLabels[config.path] ?? config.name).trim());
      }
      await loadProxy();
      setShowClash(false);
      showToast(`已导入 ${total} 个 Clash 配置`);
    } catch (e) { showError(e, "批量导入失败"); }
    finally { setSubBusy(null); }
  }
  async function renameSource(source: ProxySource) {
    const result = await showPrompt({
      title: "修改订阅备注",
      fields: [{ key: "label", label: "备注名", defaultValue: source.label, placeholder: "留空恢复默认" }],
      confirmLabel: "保存",
    });
    if (!result) return;
    setSubBusy("正在保存备注名…");
    proxyRename(source.name, result.label ?? "")
      .then(async () => { await loadProxy(); showToast("备注名已更新"); })
      .catch((e) => showError(e, "修改备注失败"))
      .finally(() => setSubBusy(null));
  }
  async function removeSource(source: ProxySource) {
    const ok = await showConfirm({
      title: "删除代理订阅",
      message: `确定删除「${source.label}」吗？使用该订阅节点的环境需要重新选择节点。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setSubBusy("正在删除…");
    proxyDelete(source.name)
      .then(async () => { await loadProxy(); showToast(`已删除「${source.label}」`); })
      .catch((e) => showError(e, "删除失败"))
      .finally(() => setSubBusy(null));
  }
  async function pickCore() {
    try {
      const chosen = await pickDialog({
        kind: "open_file",
        title: "选择 mihomo 内核",
        filter: "mihomo 内核 (mihomo.exe)|mihomo.exe|可执行文件 (*.exe)|*.exe",
      });
      if (!chosen) return;
      setSubBusy("正在检测内核…");
      const core = await proxySetCore(chosen);
      setProxyCore(core);
      showToast("已设置 mihomo 内核");
    } catch (e) { showError(e, "设置内核失败"); }
    finally { setSubBusy(null); }
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
    reorderIdentities(next).then(() => refresh(true)).catch((e) => { showError(e, "排序保存失败"); refresh(true); });
  }
  function endDrag() {
    setDragId(null);
    setDragOverId(null);
  }
  function showNoteTip(event: ReactMouseEvent<HTMLSpanElement>, note: string) {
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
  function hideNoteTip() { setNoteTip(null); }

  const create = () => withBusy("create", async () => {
    const payload: CreateRequest = {
      ...form,
      network: netChoice === "direct" ? "direct" : "proxy",
      proxy_server: netChoice === "custom" ? form.proxy_server : null,
      proxy_source: netChoice === "sub" ? form.proxy_source : null,
      proxy_node: netChoice === "sub" ? form.proxy_node : null,
    };
    await createIdentity(payload);
    setForm(emptyForm());
    setNetChoice("direct");
    setShowCreate(false);
    showToast(`已创建环境「${payload.name.trim()}」`);
  }, "创建环境失败");

  function openEdit(it: Identity) {
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

  async function exportCurrent() {
    if (!editTarget) return;
    const target = editTarget;
    let output: string | null;
    try {
      output = await pickDialog({
        kind: "save_file",
        title: "导出身份包",
        filter: "Cacer 身份包 (*.sfx)|*.sfx",
        defaultName: `${safeFileStem(target.name || target.id)}.sfx`,
        defaultDir: "packs",
      });
    } catch (e) { showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy(`export-${target.id}`, async () => {
      const result = await exportPack(target.id, target.name, output);
      await loadData();
      await showMessage({
        tone: "success",
        title: "身份导出完成",
        message: `已导出环境「${target.name || target.id}」。`,
        filePath: result.file,
      });
    }, "导出身份失败");
  }

  async function exportCookiesCurrent() {
    if (!editTarget) return;
    const target = editTarget;
    let output: string | null;
    try {
      output = await pickDialog({
        kind: "save_file",
        title: "导出 Cookie",
        filter: "Cookie JSON (*.json)|*.json",
        defaultName: `${safeFileStem(target.name || target.id)}-cookies.json`,
        defaultDir: "downloads",
      });
    } catch (e) { showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy(`cookies-${target.id}`, async () => {
      const result = await exportCookies(target.id, output!);
      await showMessage({
        tone: "success",
        title: "Cookie 导出完成",
        message: `已导出 ${result.count} 条 Cookie。文件可能包含网站登录凭据，请妥善保管。`,
        filePath: result.archive,
      });
    }, "导出 Cookie 失败");
  }

  async function importIdentityFile() {
    let chosen: string | null;
    try {
      chosen = await pickDialog({
        kind: "open_file",
        title: "导入身份包",
        filter: "Cacer 身份包 (*.sfx)|*.sfx|所有文件 (*.*)|*.*",
        defaultDir: "packs",
      });
    } catch (e) { showError(e, "无法打开文件选择窗口"); return; }
    if (!chosen) return;
    await withBusy("import-file", async () => {
      const imported = await importPack(chosen!);
      await loadData();
      await showMessage({
        tone: "success",
        title: "身份导入完成",
        message: `已导入环境「${imported.name || imported.id}」。`,
      });
    }, "导入身份失败");
  }

  const importArchive = (file: string) => withBusy(`import-${file}`, async () => {
    const imported = await importPack(file);
    await loadData();
    await showMessage({
      tone: "success",
      title: "身份导入完成",
      message: `已导入环境「${imported.name || imported.id}」。`,
    });
  }, "导入身份失败");

  async function exportAll() {
    const stamp = new Date().toISOString().slice(0, 10);
    let output: string | null;
    try {
      output = await pickDialog({
        kind: "save_file",
        title: "导出全部数据",
        filter: "Cacer 数据包 (*.zip)|*.zip",
        defaultName: `cacer-data-${stamp}.zip`,
        defaultDir: "downloads",
      });
    } catch (e) { showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy("export-all", async () => {
      const result = await exportAllData(output!);
      await loadData();
      await showMessage({
        tone: "success",
        title: "全部数据导出完成",
        message: `已打包 ${result.files} 个文件（包含全部环境、账号密码、订阅与设置）。`,
        filePath: result.archive,
      });
    }, "导出全部数据失败");
  }

  async function importAll() {
    let chosen: string | null;
    try {
      chosen = await pickDialog({
        kind: "open_file",
        title: "导入全部数据",
        filter: "Cacer 数据包 (*.zip)|*.zip|所有文件 (*.*)|*.*",
        defaultDir: "downloads",
      });
    } catch (e) { showError(e, "无法打开文件选择窗口"); return; }
    if (!chosen) return;
    const ok = await showConfirm({
      title: "确认导入全部数据",
      message: "导入会覆盖同名环境、订阅与设置，建议先停止所有浏览器。确定继续吗？",
      confirmLabel: "开始导入",
      danger: true,
    });
    if (!ok) return;
    await withBusy("import-all", async () => {
      const result = await importAllData(chosen!);
      await loadData();
      await showMessage({
        tone: "success",
        title: "数据导入完成",
        message: `已恢复 ${result.files} 个文件到数据目录。`,
        filePath: result.data,
      });
    }, "导入全部数据失败");
  }

  async function cloneEnvironment() {
    if (!editTarget) return;
    const target = editTarget;
    const result = await showPrompt({
      title: "复制为新环境",
      fields: [{ key: "name", label: "新环境名称", defaultValue: `${target.name}-副本`, required: true }],
      confirmLabel: "复制",
    });
    if (!result?.name) return;
    await withBusy(`clone-${target.id}`, async () => {
      await cloneIdentity(target.id, result.name);
      setEditTarget(null);
      showToast(`已复制为「${result.name}」`);
    }, "复制环境失败");
  }

  async function saveEdit() {
    if (!editTarget) return;
    const target = editTarget;
    const live = !!target.running || target.status === "starting";
    const fingerprintChanged = editForm.os !== target.os || editForm.country !== target.country;
    if (!live && fingerprintChanged) {
      const ok = await showConfirm({
        title: "确认重建设备指纹",
        message: "修改国家或系统会生成新的设备指纹并清空浏览器缓存，原有 Cookie 和登录状态可能失效。",
        confirmLabel: "继续保存",
        danger: true,
      });
      if (!ok) return;
    }
    await withBusy(`edit-${target.id}`, async () => {
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
      await editIdentity(target.id, req);
      if (!live && fingerprintChanged) await rebuildIdentity(target.id, editForm.os ?? "", editForm.country ?? "");
      setEditTarget(null);
      showToast("环境配置已保存");
    }, "保存失败");
  }

  async function remove(it: Identity) {
    const ok = await showConfirm({
      title: "删除环境",
      message: `确定删除「${it.name}」吗？默认只删除身份配置，不删除浏览器数据。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await withBusy(`del-${it.id}`, async () => {
      await deleteIdentity(it.id, false);
      showToast(`已删除「${it.name}」`);
    }, "删除失败");
  }

  const valid = form.name.trim().length > 0 && (netChoice === "direct" || (netChoice === "sub" ? !!form.proxy_source && !!form.proxy_node : !!form.proxy_server?.trim()));
  const editBusy = !!editTarget && ["cookies", "export", "clone", "edit"].some((action) => busy.has(`${action}-${editTarget.id}`));
  const editLive = !!editTarget?.running || editTarget?.status === "starting";
  const editValid = (editForm.name ?? "").trim().length > 0 && (editLive || editNetChoice === "direct" || (editNetChoice === "sub" ? !!editForm.proxy_source && !!editForm.proxy_node : !!(editForm.proxy_server ?? "").trim()));

  const runningList = identities.filter((it) => it.running || it.status === "starting");
  const proxyEnvs = identities.filter((it) => it.network_mode === "proxy");

  const coreBlock = <>
    <SectionTitle tip="订阅节点依赖 mihomo 内核。可将 mihomo.exe 放入软件目录的 tools 文件夹，或手动指定路径；Clash Verge 自带的 mihomo 也会自动识别。">
      代理内核（mihomo）
    </SectionTitle>
    <div className="proxy-core">
      <span className={`proxy-dot ${proxyCore?.found ? "ok" : "warn"}`} />
      <span>{proxyCore === null ? "正在检测…" : proxyCore.found ? <>已检测到 <code>{proxyCore.path}</code></> : "未检测到 mihomo 内核"}</span>
    </div>
    <div className="settings-actions">
      <button className="secondary" onClick={loadProxy} disabled={!!subBusy}>重新检测</button>
      <button className="secondary" onClick={pickCore} disabled={!!subBusy}>选择内核文件</button>
    </div>
    {subBusy && <div className="form-progress">{subBusy}</div>}
  </>;

  const subBlock = <>
    <SectionTitle tip="支持导入本地 Clash YAML 配置、订阅链接，或直接扫描本机 Clash 客户端中的配置。">
      代理订阅
    </SectionTitle>
    {proxySourceList.length === 0
      ? <div className="empty-mini compact-empty">暂无订阅</div>
      : <div className="sub-list">{proxySourceList.map((s) => <div className="sub-row" key={s.name}><div className="sub-info"><strong>{s.label}</strong><span>{s.nodes} 个节点 · {s.updated_at}</span></div><div className="row-actions"><button className="secondary" onClick={() => renameSource(s)} disabled={!!subBusy}>备注</button><button className="more-action danger-text" onClick={() => removeSource(s)} disabled={!!subBusy}>删除</button></div></div>)}</div>}
    <div className="settings-actions">
      <button className="secondary" onClick={() => importBy("file")} disabled={!!subBusy}>导入本地文件</button>
      <button className="secondary" onClick={() => importBy("url")} disabled={!!subBusy}>订阅链接</button>
      <button className="secondary" onClick={scanClash} disabled={!!subBusy}>扫描 Clash 配置</button>
    </div>
  </>;

  const dataBlock = <>
    <SectionTitle tip="环境配置、身份包、订阅与代理配置都保存在同一个数据目录，迁移时可整目录复制或使用下方备份功能。">
      数据目录
    </SectionTitle>
    <div className="data-line"><code>{dataInfo?.dir ?? "正在读取…"}</code></div>
    <div className="settings-actions">
      <button className="secondary" onClick={openDataFolder}>打开文件夹</button>
      <button className="secondary" onClick={loadData}>刷新</button>
    </div>
    <div className="section-spacer" />
    <SectionTitle tip="导出全部数据（.zip）：整机全量备份，含所有环境、账号密码、订阅、扩展与设置，导入时覆盖同名文件。&#10;导出/导入身份包（.sfx）：针对单个环境（含其指纹、Cookie 与密码），导入时新增环境不覆盖已有数据，适合单环境迁移或分享。">
      导入与导出
    </SectionTitle>
    <div className="settings-actions">
      <PendingButton className="primary" onClick={exportAll} disabled={busy.size > 0} busy={busy.has("export-all")} idle="导出全部数据" pending="导出中…" />
      <PendingButton className="secondary" onClick={importAll} disabled={busy.size > 0} busy={busy.has("import-all")} idle="导入全部数据" pending="导入中…" />
      <PendingButton className="secondary" onClick={importIdentityFile} disabled={busy.size > 0} busy={busy.has("import-file")} idle="导入身份包 (.sfx)" pending="导入中…" />
    </div>
    {dataInfo && dataInfo.packs.length > 0 && (
      <div className="sub-list">
        {dataInfo.packs.map((p) => (
          <div className="sub-row" key={p.name}>
            <div className="sub-info">
              <strong>{p.name}</strong>
              <span>{formatSize(p.size)} · {formatStamp(p.modified)}</span>
            </div>
            <div className="row-actions">
              <button className="secondary" onClick={() => {
                const sep = dataInfo.packs_dir.endsWith("\\") ? "" : "\\";
                revealPath(`${dataInfo.packs_dir}${sep}${p.name}`).catch((e) => showError(e));
              }}>定位</button>
              <PendingButton className="secondary" onClick={() => importArchive(p.name)} disabled={busy.size > 0} busy={busy.has(`import-${p.name}`)} idle="导入" pending="导入中…" />
            </div>
          </div>
        ))}
      </div>
    )}
  </>;

  const runtimeControls = <section className="edit-section">
    <SectionTitle tip="优先复用本机已有 Python 创建独立虚拟环境并自动通过国内镜像或代理安装依赖，避免下载完整 Python 包；未检测到时可选择本地目录或按指引安装。">
      运行环境
    </SectionTitle>
    {environment && <EnvChecks checks={environment.checks} pythonDetected={environment.python_detected} onAction={handleEnvAction} busy={runtimeBusy} />}
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
      <button className="secondary" disabled={runtimeBusy || !!updateState?.busy} onClick={clearDownloadProxy}>重置下载代理</button>
    </div>
    <details className="compact-details" open={manualOpen} onToggle={(e) => setManualOpen(e.currentTarget.open)}>
      <summary>手动安装 Python / 指定本地目录</summary>
      <label className="edit-field">
        <FieldLabel tip="可选择或粘贴本机 Python 安装目录（或 python.exe 路径）。已有依赖将直接启用；缺依赖时自动基于该 Python 创建独立环境并安装。">
          Python 目录或 python.exe 路径
        </FieldLabel>
        <div className="path-picker-row">
          <input value={pythonPath} onChange={(e) => setPythonPath(e.target.value)} placeholder="例如：C:\Python312 或 C:\…\python.exe" disabled={runtimeBusy} />
          <button type="button" className="secondary" disabled={runtimeBusy} onClick={() => browsePython("dir", false)}>选择目录</button>
          <button type="button" className="secondary" disabled={runtimeBusy} onClick={() => browsePython("file", false)}>选择文件</button>
        </div>
      </label>
      <div className="settings-actions">
        <button className="primary" onClick={applyPython} disabled={runtimeBusy || !pythonPath.trim()}>使用此 Python（缺依赖时自动安装）</button>
      </div>
      <div className="manual-cmd-wrap">
        <div className="manual-cmd-head">
          <span>PowerShell 安装命令</span>
          <InfoTip text="如果本机尚未安装 Python，可将以下命令复制到 PowerShell 执行安装。" />
        </div>
        <pre className="cmd-block">{guideText}</pre>
      </div>
      <div className="settings-actions">
        <button className="secondary" onClick={copyGuide}>{copied ? "已复制" : "复制安装命令"}</button>
        <button className="secondary" disabled={runtimeBusy} onClick={() => setupRuntime("python")}>备用：下载独立运行时{environment?.python_size ? `（${formatSize(environment.python_size)}）` : ""}</button>
      </div>
    </details>
  </section>;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={APP_ICON} alt="" /><div><strong>Cacer</strong><span>隐私浏览工作台</span></div></div>
      <nav className="nav">
        <div className="nav-group-title">工作台</div>
        <a className={`nav-item ${view === "overview" ? "active" : ""}`} onClick={() => setView("overview")}><Icon>⌂</Icon>总览</a>
        <a className={`nav-item ${view === "environments" ? "active" : ""}`} onClick={() => setView("environments")}><Icon>▦</Icon>浏览器环境<span className="nav-count">{identities.length}</span></a>
        <a className={`nav-item ${view === "proxy" ? "active" : ""}`} onClick={() => setView("proxy")}><Icon>⌁</Icon>代理管理</a>
        <a className={`nav-item ${view === "extensions" ? "active" : ""}`} onClick={() => setView("extensions")}><Icon>⧩</Icon>扩展中心<span className="nav-count">{extItems.length}</span></a>
        <a className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><Icon>◷</Icon>启动记录</a>
        <div className="nav-group-title second">系统</div>
        <a className={`nav-item ${view === "fonts" ? "active" : ""}`} onClick={() => setView("fonts")}><Icon>文</Icon>字体库</a>
        <a className="nav-item" onClick={openSettings}><Icon>⚙</Icon>设置</a>
      </nav>
      <button type="button" className={`sidebar-bottom ${environment && !environment.ready ? "service-warning" : ""}`} disabled={checkingEnvironment} onClick={checkEnvironment}
        title={environment?.checks.map(item => `${item.label}：${item.ok ? "正常" : "待处理"}`).join("\n") || "检查本机运行环境"}>
        <i className="health-dot"/><div><strong aria-live="polite">{checkingEnvironment ? "正在检测…" : environment?.ready ? "本地服务正常" : "需要检查环境"}</strong><span>Cacer {appVersion}{!checkingEnvironment && !environment?.ready && " · 点击检测"}</span></div>
      </button>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>工作台</span><b>/</b><strong>{VIEW_LABEL[view]}</strong></div>
        <div className="top-actions">
          {update?.available && <button className="icon-button update-button" title={`发现新版本 ${update.latest}`} onClick={() => setShowUpdate(true)}>⤓<i className="update-dot" /></button>}
          <button className="icon-button" title="刷新" onClick={() => refresh(true)}>↻</button>
          <button className="icon-button" title="设置" onClick={openSettings}>⚙</button>
        </div>
      </header>

      <div className="content">
        {environment && !environment.ready && (
          <div className="banner warning env-banner">
            <div className="env-banner-body">
              <div className="env-banner-head">
                <strong>运行环境未就绪</strong>
                <button className="env-recheck" onClick={checkEnvironment} disabled={runtimeBusy}>重新检查</button>
              </div>
              <EnvChecks checks={environment.checks} pythonDetected={environment.python_detected} onAction={handleEnvAction} busy={runtimeBusy} />
            </div>
          </div>
        )}

        {view === "fonts" && <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">FONT LIBRARY</div>
              <div className="heading-with-tip"><h1>字体库</h1><InfoTip text="按环境所需字形分包下载，已缓存字体在所有环境中共享。选择具体环境时还会核对界面语言和系统指纹所需字形，英语环境也可能用到中日韩字体。" /></div>
            </div>
            <button className="secondary" onClick={loadFontPlan} disabled={runtimeBusy || fontLoading}>刷新索引</button>
          </div>
          <section className="panel font-panel">
            <div className="grid">
              <label><span>按环境检查</span><select value={fontIdentity} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontIdentity(e.target.value); setFontCountry(""); setPendingLaunch(null); }}><option value="">选择环境…</option>{identities.map((it) => <option key={it.id} value={it.id}>{it.name || it.id} · {it.country} · {OS_LABELS[it.os] ?? it.os}</option>)}</select></label>
              <label><span>按国家 / 地区预下载</span><select value={fontCountry} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontCountry(e.target.value); setFontIdentity(""); setPendingLaunch(null); }}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{value ? label : "仅公共字体"}</option>)}</select></label>
            </div>
            {fontLoading && <div className="form-progress">正在读取环境的字体需求…</div>}
            {fontPlan?.development && <div className="empty-mini compact-empty">当前开发环境直接使用本地引擎字体。</div>}
            {fontPlan && !fontPlan.development && <>
              <div className="font-summary"><strong>{fontPlan.packs.filter((pack) => pack.cached).length} / {fontPlan.packs.length} 个包已缓存</strong><span>当前缺少 {fontPlan.packs.filter((pack) => pack.required && !pack.cached).length} 个所需包 · 需下载 {formatSize(fontPlan.missing_size)}</span></div>
              <div className="settings-actions">
                <button className="primary" disabled={runtimeBusy || fontLoading || fontPlan.ready} onClick={() => setupRuntime("fonts", fontPlan.packs.filter((pack) => pack.required).map((pack) => pack.id))}>下载当前所需</button>
                <button className="secondary" disabled={runtimeBusy || fontLoading || !selectedFonts.length} onClick={() => setupRuntime("fonts", selectedFonts)}>下载勾选项</button>
                <button className="secondary" disabled={runtimeBusy || fontLoading || fontPlan.packs.every((pack) => pack.cached)} onClick={() => setupRuntime("fonts", fontPlan.packs.map((pack) => pack.id))}>全部下载（{formatSize(fontPlan.packs.filter((pack) => !pack.cached).reduce((sum, pack) => sum + pack.size, 0))}）</button>
                {pendingLaunch && <button className="primary" disabled={runtimeBusy || fontLoading || !fontIdentity} onClick={() => withBusy("font-launch", downloadAndLaunch, "启动失败")}>{fontPlan.ready ? "启动环境" : "下载所需并启动"}</button>}
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
          <div className="page-heading">
            <div><div className="eyebrow">DASHBOARD</div><h1>总览</h1></div>
            <button className="primary large" onClick={openCreate}>＋ 新建环境</button>
          </div>
          <section className="stats">
            <div className="stat-card"><span className="stat-icon purple">▦</span><div><span>全部环境</span><strong>{identities.length}</strong></div></div>
            <div className="stat-card"><span className="stat-icon green">●</span><div><span>正在运行</span><strong>{running}</strong></div></div>
            <div className="stat-card"><span className="stat-icon blue">⌁</span><div><span>已配置代理</span><strong>{proxyCount}</strong></div></div>
            <div className="stat-card"><span className="stat-icon orange">✓</span><div><span>服务状态</span><strong className="status-text">{environment?.ready ? "正常" : "待检查"}</strong></div></div>
          </section>
          <section className="panel panel-pad">
            <h3 className="block-title">正在运行的浏览器</h3>
            {runningList.length === 0
              ? <div className="empty-mini">当前没有运行中的浏览器环境。</div>
              : <div className="sub-list">{runningList.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.network_mode === "direct" ? "直连" : it.proxy_node ?? it.proxy_server ?? "代理"}</span></div><span className={`status ${it.status === "starting" ? "starting" : "online"}`}><i />{it.status === "starting" ? "启动中" : "运行中"}</span></div>)}</div>}
          </section>
          <section className="panel panel-pad">
            <h3 className="block-title">快速操作</h3>
            <div className="settings-actions">
              <button className="secondary" onClick={openCreate}>新建环境</button>
              <PendingButton className="secondary" onClick={importIdentityFile} disabled={busy.size > 0} busy={busy.has("import-file")} idle="导入身份 (.sfx)" pending="导入中…" />
              <button className="secondary" onClick={openSettings}>数据备份与迁移</button>
              <button className="secondary" onClick={() => setView("proxy")}>代理订阅</button>
              <button className="secondary" onClick={() => setView("history")}>启动记录</button>
            </div>
          </section>
        </>}

        {view === "environments" && <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">ENVIRONMENT MANAGER</div>
              <div className="heading-with-tip"><h1>浏览器环境</h1><InfoTip text="每个环境拥有独立的设备指纹、Cookie、缓存与代理出口。列表支持拖动调整顺序。" /></div>
            </div>
            <div className="heading-actions">
              <PendingButton className="secondary" onClick={importIdentityFile} disabled={busy.size > 0} busy={busy.has("import-file")} idle="导入身份" pending="导入中…" />
              <button className="primary large" onClick={openCreate}>＋ 新建环境</button>
            </div>
          </div>
          <section className="panel">
            <div className="toolbar">
              <div className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索环境名称、国家或代理" /></div>
              <div className="toolbar-right">
                <span className="result-count">共 {visible.length} 个环境</span>
                {!search.trim() && identities.length > 1 && <InfoTip text="拖动表格行可调整环境显示顺序。" />}
              </div>
            </div>
            {visible.length === 0 ? (
              <div className="empty">
                <img className="empty-mark" src={APP_ICON} alt="" />
                <h3>{identities.length ? "没有匹配的环境" : "开始创建第一个环境"}</h3>
                <p>{identities.length ? "尝试更换搜索关键词。" : "创建新环境，或导入已有身份包。"}</p>
                {!identities.length && (
                  <div className="empty-actions">
                    <button className="primary" onClick={openCreate}>＋ 新建环境</button>
                    <PendingButton className="secondary" onClick={importIdentityFile} disabled={busy.size > 0} busy={busy.has("import-file")} idle="导入身份包" pending="导入中…" />
                  </div>
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>环境</th><th>状态</th><th>设备</th><th>网络</th><th>地区 / 语言</th><th className="actions-head">操作</th></tr></thead>
                  <tbody>
                    {visible.map((it) => (
                      <tr key={it.id} draggable={canDrag} className={dragId === it.id ? "row-dragging" : dragOverId === it.id && dragId !== it.id ? "row-drop-target" : undefined} onDragStart={(e) => startDrag(e, it.id)} onDragOver={(e) => overRow(e, it.id)} onDrop={(e) => dropRow(e, it.id)} onDragEnd={endDrag}>
                        <td><div className="profile-cell"><div className="country-avatar"><Flag country={it.country} size={26} /></div><div><strong>{it.name || it.id}</strong><span onMouseEnter={(e) => showNoteTip(e, it.note)} onMouseLeave={hideNoteTip}>{inlineNote(it.note) || `创建于 ${it.created_at?.slice(0, 10) ?? "—"}`}</span></div></div></td>
                        <td><span className={`status ${it.status === "starting" ? "starting" : it.running ? "online" : "offline"}`}><i />{it.status === "starting" ? "启动中" : it.running ? "运行中" : "已停止"}</span></td>
                        <td><span className="device"><b>{OS_ICONS[it.os] ?? "◈"}</b>{OS_LABELS[it.os] ?? it.os}</span></td>
                        <td><span className="network" title={it.proxy_node ?? it.proxy_server ?? undefined}><i className={it.network_mode === "direct" ? "direct" : "proxy"} />{it.network_mode === "direct" ? "直连" : it.proxy_node ?? "代理"}</span></td>
                        <td><span className="locale"><Flag country={it.country} size={17} /> {it.country || "自动"}<small>{it.languages?.[0] ?? it.locale}</small></span></td>
                        <td>
                          <div className="table-actions">
                            {it.running || it.status === "starting"
                              ? <button className="action stop-action" disabled={busy.has(`stop-${it.id}`) || busy.has(`launch-${it.id}`)} aria-busy={busy.has(`stop-${it.id}`)} onClick={() => withBusy(`stop-${it.id}`, () => stopIdentity(it.id), "停止失败")}><ButtonLabel busy={busy.has(`stop-${it.id}`)} idle={it.status === "starting" ? "取消" : "停止"} pending={it.status === "starting" ? "取消中…" : "停止中…"} /></button>
                              : <button className="action launch-action" disabled={busy.has(`launch-${it.id}`) || busy.has(`stop-${it.id}`)} aria-busy={busy.has(`launch-${it.id}`)} onClick={() => withBusy(`launch-${it.id}`, () => launchPrepared(it.id), "启动失败")}><ButtonLabel busy={busy.has(`launch-${it.id}`)} idle="启动" pending="启动中…" /></button>}
                            <button className="more-action" onClick={() => openEdit(it)}>编辑</button>
                            <button className="more-action danger-text" disabled={it.running} onClick={() => remove(it)}>删除</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>}

        {view === "proxy" && <>
          <div className="page-heading">
            <div><div className="eyebrow">PROXY MANAGER</div><h1>代理管理</h1></div>
          </div>
          <section className="panel panel-pad">{coreBlock}</section>
          <section className="panel panel-pad">{subBlock}</section>
          <section className="panel panel-pad">
            <h3 className="block-title">环境代理分配</h3>
            {proxyEnvs.length === 0
              ? <div className="empty-mini">暂无使用代理的环境。</div>
              : <div className="sub-list">{proxyEnvs.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.proxy_node ?? it.proxy_server ?? "代理"}{it.proxy_source ? ` · ${it.proxy_source}` : ""}</span></div><span className={`status ${it.running ? "online" : "offline"}`}><i />{it.running ? "运行中" : "已停止"}</span></div>)}</div>}
          </section>
        </>}

        {view === "extensions" && <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">EXTENSION CENTER</div>
              <div className="heading-with-tip"><h1>扩展中心</h1><InfoTip text="从 Firefox 官方商店（addons.mozilla.org）安装或本地导入扩展。安装后所有环境默认启用，可在单个环境的编辑窗口中按需关闭；Chrome / Edge 商店插件不兼容。" /></div>
            </div>
            <div className="heading-actions">
              <PendingButton className="secondary" onClick={() => importExtension("file")} disabled={!!extBusy} busy={extBusy === "import"} idle="导入 XPI / ZIP" pending="导入中…" />
              <button className="secondary" onClick={() => importExtension("dir")} disabled={!!extBusy}>导入扩展目录</button>
            </div>
          </div>
          <section className="panel panel-pad">
            <h3 className="block-title">搜索 Firefox 扩展</h3>
            <div className="ext-search">
              <input value={extQuery} onChange={(e) => setExtQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") searchExtensions(); }} placeholder="例如：ublock、沉浸式翻译、LastPass…" />
              <PendingButton className="primary" onClick={searchExtensions} disabled={!!extBusy || !extQuery.trim()} busy={extBusy === "search"} idle="搜索" pending="搜索中…" />
            </div>
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
            <div className="section-title-row block-title-row">
              <h3 className="block-title">已安装扩展</h3>
              <InfoTip text="默认在所有环境启用。可在「浏览器环境 → 编辑 → 浏览器扩展」单独开关，下次启动生效，不影响环境指纹。" />
            </div>
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
          <div className="page-heading">
            <div><div className="eyebrow">LAUNCH LOG</div><h1>启动记录</h1></div>
            <button className="secondary" onClick={loadHistory}>刷新</button>
          </div>
          <section className="panel">
            {history.length === 0
              ? <div className="empty"><div className="empty-mark">◷</div><h3>暂无启动记录</h3><p>启动任意环境后，这里会显示时间、网络方式与事件。</p></div>
              : <div className="table-wrap"><table><thead><tr><th>时间</th><th>环境</th><th>事件</th><th>网络</th></tr></thead><tbody>{history.map((item, index) => <tr key={`${item.at}-${item.id}-${index}`}><td>{item.at}</td><td><div className="profile-cell"><div><strong>{item.name || item.id}</strong><span>{item.id}</span></div></div></td><td><span className={`status ${item.event === "launch" ? "online" : "offline"}`}><i />{EVENT_LABEL[item.event] ?? item.event}</span></td><td>{item.network ?? "—"}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
      </div>
    </section>

    {runtimeBusy && downloadState && (
      <DownloadProgress state={downloadState} onCancel={() => cancelRuntime().catch((e) => showError(e))} />
    )}

    {showCreate && (
      <Modal title="新建浏览器环境" closeDisabled={busy.has("create")} onClose={() => { if (!busyRef.current.has("create")) setShowCreate(false); }}>
        {busy.has("create") && <div className="form-progress">正在生成隔离指纹，请稍候…</div>}
        <div className="grid">
          <label><FieldLabel required>环境名称</FieldLabel><input value={form.name} placeholder="例如：法国小店-A" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label><span>备注</span><textarea rows={2} value={form.note} placeholder="选填，支持换行" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <label><span>设备系统</span><select value={form.os ?? ""} onChange={(e) => setForm({ ...form, os: e.target.value || null })}>{OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <label><FieldLabel tip="语言、时区与设备指纹将自动跟随所选国家。">国家 / 地区</FieldLabel><select value={form.country ?? ""} onChange={(e) => setForm({ ...form, country: e.target.value || null })}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide"><FieldLabel tip="仅影响浏览器菜单与对话框显示，不改变网站识别到的语言和地区。选择「跟随环境语言」时，日期与数字格式也与当地完全一致。">浏览器界面语言</FieldLabel><select value={form.ui_locale ?? "zh-CN"} onChange={(e) => setForm({ ...form, ui_locale: e.target.value })}><option value="zh-CN">中文（菜单显示中文）</option><option value="">跟随环境语言（一致性最高）</option></select></label>
          <label className="wide"><FieldLabel tip="允许浏览器在内存中复用已缓存资源，减少重复下载。">内存缓存</FieldLabel><div className="seg">{([["on", "开启（推荐）"], ["off", "关闭"]] as const).map(([value, label]) => <button type="button" key={value} className={(form.memory_cache === false) === (value === "off") ? "seg-on" : "seg-off"} onClick={() => setForm({ ...form, memory_cache: value === "on" })}>{label}</button>)}</div></label>
          <label className="wide"><span>网络方式</span><div className="seg">{([["direct", "直连"], ["sub", "订阅节点"], ["custom", "手动代理"]] as const).map(([value, label]) => <button type="button" key={value} className={netChoice === value ? "seg-on" : "seg-off"} onClick={() => setNetChoice(value)}>{label}</button>)}</div></label>
          {netChoice === "sub" && <>
            <label className="wide"><FieldLabel tip="若列表中暂无订阅，请先到左侧「代理管理」导入。">代理订阅</FieldLabel><select value={form.proxy_source ?? ""} onChange={(e) => chooseSubSource(e.target.value, false)}><option value="">选择订阅…</option>{proxySourceList.map((s) => <option key={s.name} value={s.name}>{s.label}（{s.nodes} 个节点）</option>)}</select></label>
            <label className="wide"><span>节点</span><select value={form.proxy_node ?? ""} onChange={(e) => setForm({ ...form, proxy_node: e.target.value || null })} disabled={!form.proxy_source}><option value="">{form.proxy_source ? "选择节点…" : "请先选择订阅"}</option>{subNodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.type ? ` · ${n.type}` : ""}</option>)}</select></label>
          </>}
          {netChoice === "custom" && <label className="wide"><FieldLabel tip="未写协议时默认按 HTTP 处理，也支持 socks5:// 等协议前缀。">代理服务器</FieldLabel><input value={form.proxy_server ?? ""} placeholder="127.0.0.1:8080" onChange={(e) => setForm({ ...form, proxy_server: e.target.value })} /></label>}
        </div>
        <div className="modal-footer">
          <button className="secondary" disabled={busy.has("create")} onClick={() => setShowCreate(false)}>取消</button>
          <button className="primary" disabled={!valid || busy.has("create")} aria-busy={busy.has("create")} onClick={create}><ButtonLabel busy={busy.has("create")} idle="生成环境" pending="生成中…" /></button>
        </div>
      </Modal>
    )}

    {showSettings && (
      <Modal title="设置" onClose={() => setShowSettings(false)}>
        <section className="edit-section">{dataBlock}</section>
        {runtimeControls}
        <section className="edit-section">
          <SectionTitle tip="启动时会自动静默检查 GitHub 最新版本；下载更新包时自动尝试内置镜像与系统代理，并校验 SHA256 摘要。">
            软件更新与关于
          </SectionTitle>
          <div className="version-row">
            <span>当前版本 <strong>v{appVersion}</strong>{update?.available && <em className="version-new"> · 新版本 v{update.latest} 可用</em>}</span>
            <div className="row-actions">
              {update?.available && <button className="primary" onClick={() => { setShowSettings(false); setShowUpdate(true); }}>立即更新</button>}
              <PendingButton className="secondary" onClick={manualCheckUpdate} busy={checkingUpdate} idle="检查更新" pending="检查中…" />
            </div>
          </div>
          <details className="compact-details">
            <summary>许可与仓库信息</summary>
            <p className="about-line">项目仓库：<a href="https://github.com/baseless1119/CacerBrowser" target="_blank" rel="noreferrer">github.com/baseless1119/CacerBrowser</a></p>
            <p className="about-line">Cacer 自定义软件许可 · 原创部分由著作权人保留全部权利。未经书面许可，禁止以商业目的重新打包或分发。第三方组件适用各自许可。</p>
          </details>
        </section>
      </Modal>
    )}

    {showUpdate && update && (
      <Modal title="发现新版本" onClose={() => { if (!updateState?.busy) setShowUpdate(false); }}>
        <section className="edit-section">
          <div className="update-versions"><span>当前版本 <strong>{update.current}</strong></span><span>最新版本 <strong>{update.latest}</strong></span><span>安装包 {formatSize(update.size)}</span></div>
          {update.notes && <pre className="update-notes">{update.notes}</pre>}
          {updateState && <div className="form-progress" role="status">{updateState.message}{updateState.total > 0 && <> · {formatSize(updateState.downloaded)} / {formatSize(updateState.total)}<progress max={updateState.total} value={updateState.downloaded} /></>}</div>}
        </section>
        <div className="modal-footer">
          {updateState?.busy
            ? <button className="secondary" onClick={() => cancelUpdate().catch((e) => showError(e))}>取消下载</button>
            : <><button className="secondary" onClick={() => setShowUpdate(false)}>稍后</button><button className="primary" onClick={() => startUpdate()}>下载并安装</button></>}
        </div>
      </Modal>
    )}

    {showProxy && (
      <Modal title="下载线路不可用" onClose={() => setShowProxy(false)}>
        <section className="edit-section">
          {proxyStep === "ask"
            ? <p className="dialog-text">已依次尝试内置镜像和系统代理仍无法连接。是否手动设置代理后重试？</p>
            : <label className="edit-field"><span>HTTP / SOCKS5 代理地址</span><input autoFocus value={proxyValue} onChange={(e) => setProxyValue(e.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" /></label>}
        </section>
        <div className="modal-footer">
          <button className="secondary" onClick={() => { proxyRetry.current = null; setShowProxy(false); }}>取消</button>
          <button className="secondary" onClick={() => applyProxy(true)}>重置代理重试</button>
          {proxyStep === "ask"
            ? <button className="primary" onClick={() => setProxyStep("input")}>设置代理</button>
            : <button className="primary" disabled={!proxyValue.trim()} onClick={() => applyProxy()}>保存并重试</button>}
        </div>
      </Modal>
    )}

    {showClash && (
      <Modal title={`扫描到的 Clash 配置（${localClashConfigs.length}）`} onClose={() => setShowClash(false)}>
        <div className="sub-list clash-list">{localClashConfigs.map((c) => <div className="sub-row" key={c.path}>
          <input className="clash-name" value={clashLabels[c.path] ?? ""} placeholder={c.name} onChange={(e) => setClashLabels({ ...clashLabels, [c.path]: e.target.value })} disabled={!!subBusy} />
          <span className="clash-meta">{c.nodes} 个节点</span>
          <button className="secondary" onClick={() => importFromClash(c)} disabled={!!subBusy}>导入</button>
        </div>)}</div>
        {subBusy && <div className="form-progress">{subBusy}</div>}
        <div className="modal-footer">
          <button className="secondary" onClick={() => setShowClash(false)} disabled={!!subBusy}>关闭</button>
          <button className="primary" onClick={importAllClash} disabled={!!subBusy || localClashConfigs.length === 0}>全部导入</button>
        </div>
      </Modal>
    )}

    {failedTask && (
      <Modal title="安装失败" onClose={() => setFailedTask(null)}>
        <section className="edit-section">
          {failedTask === "local-python" ? <>
            <p className="dialog-text">无法通过 pip 自动安装依赖。可在 PowerShell 手动执行以下命令，或改用独立运行时。</p>
            <pre className="cmd-block">{guideText}</pre>
          </> : failedTask === "python" ? <>
            <p className="dialog-text">无法下载独立运行时。可在 PowerShell 手动执行以下命令安装，完成后点「重新检查」。</p>
            <pre className="cmd-block">{guideText}</pre>
          </> : <p className="dialog-text">字体下载失败，请检查网络后在「字体库」页面重试。</p>}
        </section>
        <div className="modal-footer">
          {(failedTask === "python" || failedTask === "local-python") && <button className="secondary" onClick={copyGuide}>{copied ? "已复制" : "复制安装命令"}</button>}
          {failedTask === "local-python" && <button className="secondary" onClick={() => { setFailedTask(null); void setupRuntime("python"); }}>改用独立运行时（备用）</button>}
          <button className="secondary" onClick={() => setFailedTask(null)}>关闭</button>
        </div>
      </Modal>
    )}

    {editTarget && (
      <Modal title="编辑环境" closeDisabled={editBusy} onClose={() => { if (!editBusy) setEditTarget(null); }}>
        <section className="edit-section">
          <SectionTitle tip="设备指纹默认保持不变，以维持 Cookie 和登录状态一致性。在浏览器内登录网站保存的密码也随本环境一并打包，可在地址栏输入 about:logins 管理。">
            身份指纹
          </SectionTitle>
          <div className="fpinfo">
            <span><Flag country={editTarget.country} size={16} /> {editTarget.country || "自动地区"}</span>
            <span>{OS_ICONS[editTarget.os]} {OS_LABELS[editTarget.os] ?? editTarget.os}</span>
            <span>◷ {editTarget.timezone}</span>
            <span>文 {editTarget.languages?.[0] ?? editTarget.locale}</span>
          </div>
        </section>
        <section className="edit-section">
          <SectionTitle>基本信息</SectionTitle>
          <div className="grid">
            <label><FieldLabel required>环境名称</FieldLabel><input value={editForm.name ?? ""} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></label>
            <label><span>备注</span><textarea rows={2} value={editForm.note ?? ""} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} /></label>
            <label><FieldLabel tip={editLive ? "运行中不可修改设备系统，请先停止浏览器。" : "修改设备系统会重新生成指纹并清空缓存。"}>设备系统</FieldLabel><select value={editForm.os ?? ""} disabled={editLive} onChange={(e) => setEditForm({ ...editForm, os: e.target.value || null })}>{OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            <label><FieldLabel tip={editLive ? "运行中不可修改国家，请先停止浏览器。" : "修改国家会重新生成指纹并清空缓存。"}>国家 / 地区</FieldLabel><select value={editForm.country ?? ""} disabled={editLive} onChange={(e) => setEditForm({ ...editForm, country: e.target.value || null })}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="wide"><FieldLabel tip="仅影响浏览器菜单与对话框显示，不改变网站识别到的语言和地区。修改后下次启动生效。">浏览器界面语言</FieldLabel><select value={editForm.ui_locale ?? ""} onChange={(e) => setEditForm({ ...editForm, ui_locale: e.target.value })}><option value="zh-CN">中文（菜单显示中文）</option><option value="">跟随环境语言（一致性最高）</option>{editForm.ui_locale && editForm.ui_locale !== "zh-CN" && <option value={editForm.ui_locale}>当前：{editForm.ui_locale}</option>}</select></label>
            <label className="wide"><FieldLabel tip="允许浏览器在内存中复用已缓存资源，减少重复下载。修改后下次启动生效。">内存缓存</FieldLabel><div className="seg">{([["on", "开启（推荐）"], ["off", "关闭"]] as const).map(([value, label]) => <button type="button" key={value} className={(editForm.memory_cache === false) === (value === "off") ? "seg-on" : "seg-off"} onClick={() => setEditForm({ ...editForm, memory_cache: value === "on" })}>{label}</button>)}</div></label>
          </div>
        </section>
        <section className="edit-section">
          <SectionTitle tip={editLive ? "浏览器运行中：名称、备注、语言、缓存和扩展开关可立即保存（下次启动生效）；网络与指纹设置需先停止浏览器。" : "代理修改在下次启动时生效，未写协议时默认按 HTTP 处理。"}>
            网络方式
          </SectionTitle>
          <div className="seg">{([["direct", "直连"], ["sub", "订阅节点"], ["custom", "手动代理"]] as const).map(([value, label]) => <button type="button" disabled={editLive} key={value} className={editNetChoice === value ? "seg-on" : "seg-off"} onClick={() => setEditNetChoice(value)}>{label}</button>)}</div>
          {editNetChoice === "sub" && <div className="grid">
            <label><span>代理订阅</span><select value={editForm.proxy_source ?? ""} disabled={editLive} onChange={(e) => chooseSubSource(e.target.value, true)}><option value="">选择订阅…</option>{proxySourceList.map((s) => <option key={s.name} value={s.name}>{s.label}（{s.nodes} 个节点）</option>)}</select></label>
            <label><span>节点</span><select value={editForm.proxy_node ?? ""} onChange={(e) => setEditForm({ ...editForm, proxy_node: e.target.value })} disabled={editLive || !editForm.proxy_source}><option value="">{editForm.proxy_source ? "选择节点…" : "请先选择订阅"}</option>{editSubNodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.type ? ` · ${n.type}` : ""}</option>)}</select></label>
          </div>}
          {editNetChoice === "custom" && <label className="edit-field"><span>代理服务器</span><input value={editForm.proxy_server ?? ""} disabled={editLive} placeholder="127.0.0.1:8080" onChange={(e) => setEditForm({ ...editForm, proxy_server: e.target.value })} /></label>}
        </section>
        <section className="edit-section">
          <SectionTitle tip="开关仅在下一次启动时决定是否加载该扩展，不重建环境指纹，不影响 Cookie 与登录状态。">
            浏览器扩展
          </SectionTitle>
          {extItems.length === 0
            ? <div className="empty-mini compact-empty">暂无已安装扩展（可在左侧「扩展中心」安装）</div>
            : <div className="ext-toggles">{extItems.map((item) => { const on = !(editForm.disabled_extensions ?? []).includes(item.slug); return <label className={`ext-toggle ${on ? "" : "off"}`} key={item.slug}><input type="checkbox" checked={on} onChange={(e) => toggleEditExtension(item.slug, e.target.checked)} /><span><strong>{item.name}</strong><small>v{item.version}{item.engine ? " · 内置" : ""}</small></span></label>; })}</div>}
        </section>
        <div className="modal-footer edit-footer">
          <div className="edit-transfer-actions">
            <PendingButton className="secondary" onClick={exportCookiesCurrent} disabled={editBusy} busy={busy.has(`cookies-${editTarget.id}`)} idle="导出 Cookie" pending="导出中…" />
            <PendingButton className="secondary" onClick={exportCurrent} disabled={editLive || editBusy} busy={busy.has(`export-${editTarget.id}`)} idle="导出身份" pending="导出中…" />
            <PendingButton className="secondary" onClick={cloneEnvironment} disabled={editLive || editBusy} busy={busy.has(`clone-${editTarget.id}`)} idle="复制为新环境" pending="复制中…" />
          </div>
          <div className="edit-save-actions">
            <button className="secondary" disabled={editBusy} onClick={() => setEditTarget(null)}>取消</button>
            <PendingButton className="primary" disabled={editBusy || !editValid} busy={busy.has(`edit-${editTarget.id}`)} onClick={saveEdit} idle="保存修改" pending="保存中…" />
          </div>
        </div>
      </Modal>
    )}

    {noteTip && <div className="note-tip" role="tooltip" style={{ left: noteTip.x, top: noteTip.y, transform: noteTip.above ? "translateY(calc(-100% - 8px))" : "none" }}>{noteTip.text}</div>}

    {promptModal && (
      <PromptDialog
        options={promptModal.options}
        onResult={(values) => { const { resolve } = promptModal; setPromptModal(null); resolve(values); }}
      />
    )}
    {confirmModal && (
      <ConfirmDialog
        options={confirmModal.options}
        onResult={(ok) => { const { resolve } = confirmModal; setConfirmModal(null); resolve(ok); }}
      />
    )}
    {messageModal && (
      <MessageDialog
        options={messageModal.options}
        onClose={() => { const { resolve } = messageModal; setMessageModal(null); resolve(); }}
      />
    )}
    <ToastHost items={toasts} onDismiss={dismissToast} />
  </main>;
}
