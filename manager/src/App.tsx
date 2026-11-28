import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  ClashConfig, CreateRequest, DataOverview, EditRequest, ExtensionItem, ExtensionSearchResult, HistoryItem, Identity, ProxyNode, ProxySource,
  cancelRuntime, installRuntime, runtimeStatus, setupLocalPython, pickPythonPath, pickDialog, revealPath, type RuntimeStatus,
  checkUpdate, downloadUpdate, updateStatus, cancelUpdate, installUpdate, type UpdateInfo, type UpdateStatus,
  saveDownloadSettings, downloadSettings, testDownloadProxy, importRuntimeArchive, openRuntimeDownloadsDir, fontOverview, type FontOverview,
  clashConfigs, cloneIdentity, createIdentity, dataOverview, deleteIdentity, editIdentity, environmentCheck,
  exportAllData, exportCookies, exportPack, extImport, extInstall, extList, extRemove, extSearch, importAllData, importPack, launchHistory, launchIdentity, listIdentities, openDataDir,
  proxyDelete, proxyImport, proxyNodes, proxyRename, proxySetCore, proxySources, rebuildIdentity, reorderIdentities, stopIdentity, stopAllIdentities, type EnvironmentCheck,
} from "./api";
import {
  APP_ICON, COUNTRY_OPTIONS, CREATE_PRESETS, DOWNLOAD_ROUTES_FAILED, EVENT_LABEL, EXT_SOURCE_LABEL, OS_ICONS, OS_LABELS, VIEW_LABEL,
  cleanError, formatSize, formatUsers, loadCreateDefaults, safeFileStem, saveCreateDefaults,
  type SettingsTab, type View,
} from "./constants";
import { ConfirmDialog, MessageDialog, PromptDialog, ToastHost, copyText } from "./Dialog";
import Flag from "./Flag";
import InfoTip from "./InfoTip";
import Modal from "./Modal";
import { IdentityFormFields, type IdentityFormData, type NetChoice } from "./components/IdentityForm";
import { DownloadProgress, EnvChecks, Icon, PendingButton, SectionTitle, type EnvCardAction } from "./components/Ui";
import { useDialogs } from "./hooks/useDialogs";
import EnvironmentsView from "./views/EnvironmentsView";
import SettingsView from "./views/SettingsView";

function formDataFromCreate(form: CreateRequest): IdentityFormData {
  return {
    name: form.name,
    note: form.note ?? "",
    os: form.os ?? "",
    country: form.country ?? "",
    ui_locale: form.ui_locale ?? "zh-CN",
    memory_cache: form.memory_cache ?? true,
    proxy_source: form.proxy_source ?? "",
    proxy_node: form.proxy_node ?? "",
    proxy_server: form.proxy_server ?? "",
  };
}

function formDataFromEdit(form: EditRequest): IdentityFormData {
  return {
    name: form.name ?? "",
    note: form.note ?? "",
    os: form.os ?? "",
    country: form.country ?? "",
    ui_locale: form.ui_locale ?? "",
    memory_cache: form.memory_cache ?? true,
    proxy_source: form.proxy_source ?? "",
    proxy_node: form.proxy_node ?? "",
    proxy_server: form.proxy_server ?? "",
  };
}

export default function App() {
  const dialogs = useDialogs();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentCheck | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const nodeRequests = useRef({ create: 0, edit: 0 });
  const refreshRequest = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const [view, setView] = useState<View>("environments");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("data");

  // Modals & forms
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateRequest>(loadCreateDefaults);
  const [netChoice, setNetChoice] = useState<NetChoice>("direct");
  const [editTarget, setEditTarget] = useState<Identity | null>(null);
  const [editForm, setEditForm] = useState<EditRequest>({});
  const [editNetChoice, setEditNetChoice] = useState<NetChoice>("direct");

  // Runtime & update tasks
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
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyCheck, setProxyCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [proxyFallbackKind, setProxyFallbackKind] = useState<"python" | "local-python" | "fonts" | null>(null);
  const [failedTask, setFailedTask] = useState<"python" | "local-python" | "fonts" | null>(null);
  const [failedFontIds, setFailedFontIds] = useState<string[]>([]);
  const [failedFontInfo, setFailedFontInfo] = useState<FontOverview | null>(null);
  const proxyRetry = useRef<((proxy: string) => void) | null>(null);
  const [pythonPath, setPythonPath] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const environmentRef = useRef<EnvironmentCheck | null>(null);
  const [copied, setCopied] = useState(false);

  // Fonts (both dedicated view & in-place launch prompt)
  const [fontPlan, setFontPlan] = useState<FontOverview | null>(null);
  const [fontCountry, setFontCountry] = useState("");
  const [fontIdentity, setFontIdentity] = useState("");
  const [selectedFonts, setSelectedFonts] = useState<string[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const fontRequest = useRef(0);
  const [fontLaunchPrompt, setFontLaunchPrompt] = useState<{ id: string; name: string; plan: FontOverview } | null>(null);

  // Proxy, Extensions, Data, History
  const [proxySourceList, setProxySourceList] = useState<ProxySource[]>([]);
  const [proxyLoaded, setProxyLoaded] = useState(false);
  const [proxyCore, setProxyCore] = useState<{ found: boolean; path: string | null } | null>(null);
  const [subNodes, setSubNodes] = useState<ProxyNode[]>([]);
  const [editSubNodes, setEditSubNodes] = useState<ProxyNode[]>([]);
  const [localClashConfigs, setLocalClashConfigs] = useState<ClashConfig[]>([]);
  const [showClash, setShowClash] = useState(false);
  const [clashLabels, setClashLabels] = useState<Record<string, string>>({});
  const [subBusy, setSubBusy] = useState<string | null>(null);
  const [dataInfo, setDataInfo] = useState<DataOverview | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [noteTip, setNoteTip] = useState<{ x: number; y: number; above: boolean; text: string } | null>(null);
  const [extItems, setExtItems] = useState<ExtensionItem[]>([]);
  const [extLoaded, setExtLoaded] = useState(false);
  const [extResults, setExtResults] = useState<ExtensionSearchResult[]>([]);
  const [extQuery, setExtQuery] = useState("");
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const [extSearched, setExtSearched] = useState(false);

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
      if (!document.hidden && !runtimeBusyRef.current) refresh();
    }, hasActive ? 3000 : 10000);
    const onVisible = () => {
      if (!document.hidden && !runtimeBusyRef.current) refresh();
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
    if (view === "overview" || view === "proxy" || view === "settings") loadData();
  }, [view]);
  useEffect(() => {
    const block = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  function openSettings(tab: SettingsTab = "data") {
    setSettingsTab(tab);
    setView("settings");
    loadData();
  }

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
        catch (e) { dialogs.showThrottledError(e); }
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
      dialogs.showError(e, "环境检查失败");
      return null;
    } finally {
      setCheckingEnvironment(false);
    }
  }

  function offerProxy(retry: (proxy: string) => void, fallbackKind: "python" | "local-python" | "fonts" | null = null) {
    proxyRetry.current = retry;
    setProxyFallbackKind(fallbackKind);
    setProxyCheck(null);
    setProxyStep("ask");
    setShowProxy(true);
    downloadSettings().then((s) => setProxyValue(s.proxy || "")).catch(() => setProxyValue(""));
  }
  function openManualGuide(kind: "python" | "local-python" | "fonts") {
    proxyRetry.current = null;
    setShowProxy(false);
    setCopied(false);
    if (kind === "fonts") {
      fontOverview(fontIdentity, fontCountry).then(setFailedFontInfo).catch(() => {});
    }
    setFailedTask(kind);
  }
  async function checkProxyConnectivity(raw?: string): Promise<boolean> {
    const target = (raw ?? proxyValue).trim();
    if (!target) {
      setProxyCheck({ ok: false, text: "请先填写代理地址（例如 http://127.0.0.1:7890）" });
      return false;
    }
    setProxyTesting(true);
    setProxyCheck(null);
    try {
      const res = await testDownloadProxy(target);
      setProxyCheck({ ok: true, text: `代理可用（GitHub 响应 ${res.latency_ms} ms）` });
      return true;
    } catch (e) {
      setProxyCheck({ ok: false, text: cleanError(e) });
      return false;
    } finally {
      setProxyTesting(false);
    }
  }
  async function applyProxy(clear = false) {
    const proxy = clear ? "" : proxyValue.trim();
    if (!clear) {
      if (!proxy) return;
      const ok = await checkProxyConnectivity(proxy);
      if (!ok) return;
    }
    try {
      await saveDownloadSettings({ proxy, mirror: "" });
      setShowProxy(false);
      setProxyCheck(null);
      const retry = proxyRetry.current;
      proxyRetry.current = null;
      retry?.(proxy);
    } catch (e) { dialogs.showError(e, "代理格式无效"); }
  }
  async function importOfflineFontZip(retryIds?: string[]) {
    let chosen: string | null;
    try {
      chosen = await pickDialog({
        kind: "open_file",
        title: "选择已下载的字体或运行时离线包 (.zip)",
        filter: "离线压缩包 (*.zip)|*.zip",
        defaultDir: "downloads",
      });
    } catch (e) { dialogs.showError(e, "无法打开文件选择窗口"); return; }
    if (!chosen) return;
    try {
      const imported = await importRuntimeArchive(chosen);
      dialogs.showToast(`校验通过：已导入「${imported.name}」`);
      if (imported.kind === "font_pack" || imported.kind === "fonts") {
        const idsToInstall = retryIds?.length
          ? Array.from(new Set([...retryIds, imported.id]))
          : imported.kind === "font_pack" ? [imported.id] : [];
        setFailedTask(null);
        await setupRuntime("fonts", idsToInstall);
      } else if (imported.kind === "python") {
        setFailedTask(null);
        await setupRuntime("python");
      }
    } catch (e) {
      dialogs.showError(e, "导入离线包失败");
    }
  }
  async function clearDownloadProxy() {
    try {
      await saveDownloadSettings({ proxy: "", mirror: "" });
      dialogs.showToast("已重置下载代理");
    } catch (e) { dialogs.showError(e); }
  }

  /// Shared runner for long-running cancellable runtime/pip/font operations.
  async function runRuntimeTask(
    initialMessage: string,
    work: () => Promise<void>,
    opts: {
      onSuccess?: () => Promise<void> | void;
      errorTitle: string;
      failKind: "python" | "local-python" | "fonts";
      proxyOverride?: string;
      retryWithProxy: (proxy: string) => void;
    },
  ): Promise<boolean> {
    if (runtimeBusyRef.current) return false;
    runtimeBusyRef.current = true;
    setRuntimeBusy(true);
    setDownloadState({ busy: true, message: initialMessage, downloaded: 0, total: 0 });
    const timer = window.setInterval(() => runtimeStatus().then(setDownloadState).catch(() => {}), 450);
    try {
      await work();
      await opts.onSuccess?.();
      return true;
    } catch (e) {
      const message = cleanError(e);
      if (!message.includes("已取消")) {
        if (!message.includes(DOWNLOAD_ROUTES_FAILED)) {
          dialogs.showError(message, opts.errorTitle);
        } else if (opts.proxyOverride !== undefined) {
          setCopied(false);
          if (opts.failKind === "fonts") {
            fontOverview(fontIdentity, fontCountry).then(setFailedFontInfo).catch(() => {});
          }
          setFailedTask(opts.failKind);
        } else {
          offerProxy(opts.retryWithProxy, opts.failKind);
        }
      }
      return false;
    } finally {
      window.clearInterval(timer);
      runtimeBusyRef.current = false;
      setRuntimeBusy(false);
      setDownloadState(null);
    }
  }

  function setupRuntime(kind: "python" | "fonts", fontIds: string[] = [], proxyOverride?: string) {
    if (kind === "fonts") {
      setFailedFontIds(fontIds);
    }
    return runRuntimeTask(
      "正在准备下载…",
      () => installRuntime(kind, proxyOverride ?? "", fontIds).then(() => {}),
      {
        onSuccess: async () => {
          if (kind === "fonts") await loadFontPlan();
          await checkEnvironment();
          dialogs.showToast(kind === "python" ? "独立运行时已就绪" : "字体已准备完成");
        },
        errorTitle: kind === "python" ? "运行时安装失败" : "字体下载失败",
        failKind: kind,
        proxyOverride,
        retryWithProxy: (retryProxy) => { void setupRuntime(kind, fontIds, retryProxy); },
      },
    );
  }

  function setupLocalRuntime(customPath?: string, proxyOverride?: string) {
    return runRuntimeTask(
      "正在检查本机 Python…",
      () => setupLocalPython(customPath, proxyOverride ?? "").then(() => {}),
      {
        onSuccess: async () => {
          await checkEnvironment();
          dialogs.showToast("已复用本机 Python 完成依赖配置");
        },
        errorTitle: "配置 Python 失败",
        failKind: "local-python",
        proxyOverride,
        retryWithProxy: (retryProxy) => { void setupLocalRuntime(customPath, retryProxy); },
      },
    );
  }

  async function manualCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const info = await checkUpdate();
      setUpdate(info);
      if (info.available) {
        setShowUpdate(true);
      } else {
        dialogs.showToast(`当前已是最新版本（v${info.current}）`, "info");
      }
    } catch (e) {
      dialogs.showError(e, "检查更新失败");
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
      setUpdateState({ busy: true, message: "下载完成，正在启动安装程序…", downloaded: update.size, total: update.size });
      await installUpdate();
      dialogs.showToast("安装程序已启动，Cacer 即将退出完成更新", "info");
    } catch (e) {
      const message = cleanError(e);
      if (!message.includes("已取消")) {
        if (message.includes(DOWNLOAD_ROUTES_FAILED)) {
          if (proxyRetried) dialogs.showError("重试后仍无法下载更新包，请检查网络或稍后重试。", "更新失败");
          else offerProxy(() => { void startUpdate(true); });
        } else {
          dialogs.showError(message, "更新失败");
        }
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
      if (request === fontRequest.current) { setFontPlan(null); dialogs.showError(e, "读取字体索引失败"); }
    } finally {
      if (request === fontRequest.current) setFontLoading(false);
    }
  }

  async function confirmFontDownloadAndLaunch() {
    if (!fontLaunchPrompt) return;
    const { id, plan } = fontLaunchPrompt;
    setFontLaunchPrompt(null);
    const neededIds = plan.packs.filter((pack) => pack.required && !pack.cached).map((pack) => pack.id);
    if (await setupRuntime("fonts", neededIds)) {
      await withBusy(`launch-${id}`, () => launchIdentity(id), "启动失败");
    }
  }

  async function browsePython(kind: "dir" | "file", autoSetup = false) {
    if (runtimeBusyRef.current) return;
    try {
      const chosen = await pickPythonPath(kind);
      if (!chosen) return;
      setPythonPath(chosen);
      if (autoSetup) await setupLocalRuntime(chosen);
    } catch (e) { dialogs.showError(e, "无法打开选择窗口"); }
  }

  async function applyPython() {
    if (!pythonPath.trim()) return;
    await setupLocalRuntime(pythonPath);
  }

  async function launchPrepared(id: string) {
    if (!environmentRef.current?.ready) {
      await dialogs.showMessage({ tone: "warning", title: "运行环境未就绪", message: "请先完成 Python 依赖配置，再启动浏览器环境。" });
      openSettings("runtime");
      return;
    }
    const plan = await fontOverview(id);
    if (!plan.ready) {
      const target = identities.find((it) => it.id === id);
      setFontLaunchPrompt({ id, name: target?.name || id, plan });
      return;
    }
    await launchIdentity(id);
  }

  const guideText = environment?.manual_commands ?? "正在读取安装命令…";
  function handleEnvAction(action: EnvCardAction) {
    if (action === "engine") {
      void dialogs.showMessage({ tone: "warning", title: "浏览器引擎缺失", message: "浏览器引擎随安装包提供，请重新运行当前版本的安装程序修复。" });
      return;
    }
    if (action === "local-python") { void setupLocalRuntime(); return; }
    if (action === "pick-dir") { void browsePython("dir", true); return; }
    setManualOpen(true);
    openSettings("runtime");
  }

  async function copyGuide() {
    await copyText(guideText);
    setCopied(true);
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
      dialogs.showError(e, errorTitle);
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
      setProxyLoaded(true);
      return overview.sources;
    } catch (e) { dialogs.showError(e, "读取代理配置失败"); return []; }
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
      if (request === nodeRequests.current[slot]) dialogs.showError(e, "读取节点失败");
    }
  }

  async function scanClash() {
    setSubBusy("正在扫描 Clash 配置…");
    try {
      const configs = (await clashConfigs()).configs;
      setLocalClashConfigs(configs);
      setClashLabels(Object.fromEntries(configs.map((c) => [c.path, c.name])));
      if (!configs.length) dialogs.showToast("未扫描到包含节点的 Clash 配置", "info");
      else setShowClash(true);
    } catch (e) { dialogs.showError(e, "扫描失败"); }
    finally { setSubBusy(null); }
  }

  async function loadData() {
    try { setDataInfo(await dataOverview()); }
    catch (e) { dialogs.showError(e, "读取数据目录失败"); }
  }
  async function loadHistory() {
    if (!environmentRef.current?.ready) return;
    try { setHistory((await launchHistory(80)).items); }
    catch (e) { dialogs.showError(e, "读取启动记录失败"); }
  }
  async function loadExtensions() {
    if (!environmentRef.current?.ready) return;
    try {
      setExtItems((await extList()).extensions);
      setExtLoaded(true);
    } catch (e) { dialogs.showError(e, "读取扩展列表失败"); }
  }

  function searchExtensions() {
    const query = extQuery.trim();
    if (!query || extBusy) return;
    setExtBusy("search");
    extSearch(query, 20)
      .then((data) => { setExtResults(data.results); setExtSearched(true); })
      .catch((e) => dialogs.showError(e, "搜索扩展失败"))
      .finally(() => setExtBusy(null));
  }
  function installExtension(slug: string) {
    setExtBusy(`install-${slug}`);
    extInstall(slug)
      .then(async (item) => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === slug ? { ...result, installed: true } : result));
        dialogs.showToast(`已安装「${item.name}」`);
      })
      .catch((e) => dialogs.showError(e, "安装扩展失败"))
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
      dialogs.showToast(`已导入扩展「${item.name}」`);
    } catch (e) {
      dialogs.showError(e, "导入扩展失败");
    } finally {
      setExtBusy(null);
    }
  }
  async function removeExtension(item: ExtensionItem) {
    const { confirmed } = await dialogs.showConfirm({
      title: "卸载扩展",
      message: `确定卸载「${item.name}」吗？卸载后所有环境都不再加载。`,
      confirmLabel: "卸载",
      danger: true,
    });
    if (!confirmed) return;
    setExtBusy(`remove-${item.slug}`);
    extRemove(item.slug)
      .then(async () => {
        await loadExtensions();
        setExtResults((results) => results.map((result) => result.slug === item.slug ? { ...result, installed: false } : result));
      })
      .catch((e) => dialogs.showError(e, "卸载失败"))
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

  function openDataFolder() { openDataDir().catch((e) => dialogs.showError(e)); }
  function openCreate() {
    if (busyRef.current.has("create")) return;
    loadNodes("", false);
    setForm(loadCreateDefaults());
    setNetChoice("direct");
    setSubNodes([]);
    setShowCreate(true);
    if (!proxyLoaded) void loadProxy();
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
      dialogs.showToast(`已导入「${result.label}」（${result.count} 个节点）`);
    } catch (e) { dialogs.showError(e, "导入订阅失败"); }
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
      } catch (e) { dialogs.showError(e, "选择文件失败"); }
      return;
    }
    const result = await dialogs.showPrompt({
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
      dialogs.showToast(`已导入 ${total} 个 Clash 配置`);
    } catch (e) { dialogs.showError(e, "批量导入失败"); }
    finally { setSubBusy(null); }
  }
  async function renameSource(source: ProxySource) {
    const result = await dialogs.showPrompt({
      title: "修改订阅备注",
      fields: [{ key: "label", label: "备注名", defaultValue: source.label, placeholder: "留空恢复默认" }],
      confirmLabel: "保存",
    });
    if (!result) return;
    setSubBusy("正在保存备注名…");
    proxyRename(source.name, result.label ?? "")
      .then(() => loadProxy())
      .catch((e) => dialogs.showError(e, "修改备注失败"))
      .finally(() => setSubBusy(null));
  }
  async function removeSource(source: ProxySource) {
    const { confirmed } = await dialogs.showConfirm({
      title: "删除代理订阅",
      message: `确定删除「${source.label}」吗？使用该订阅节点的环境需要重新选择节点。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;
    setSubBusy("正在删除…");
    proxyDelete(source.name)
      .then(() => loadProxy())
      .catch((e) => dialogs.showError(e, "删除失败"))
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
    } catch (e) { dialogs.showError(e, "设置内核失败"); }
    finally { setSubBusy(null); }
  }

  function showNoteTip(event: ReactMouseEvent<HTMLSpanElement>, note: string) {
    if (!note) return;
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
    saveCreateDefaults(form);
    setForm(loadCreateDefaults());
    setNetChoice("direct");
    setShowCreate(false);
    dialogs.showToast(`已创建「${payload.name.trim()}」`);
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
    if (!proxyLoaded) void loadProxy();
    if (!extLoaded) void loadExtensions();
  }

  async function exportTarget(target: Identity) {
    let output: string | null;
    try {
      output = await pickDialog({
        kind: "save_file",
        title: "导出身份包",
        filter: "Cacer 身份包 (*.sfx)|*.sfx",
        defaultName: `${safeFileStem(target.name || target.id)}.sfx`,
        defaultDir: "packs",
      });
    } catch (e) { dialogs.showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy(`export-${target.id}`, async () => {
      const result = await exportPack(target.id, target.name, output);
      await loadData();
      await dialogs.showMessage({
        tone: "success",
        title: "身份导出完成",
        message: `已导出环境「${target.name || target.id}」。`,
        filePath: result.file,
      });
    }, "导出身份失败");
  }

  async function exportCookiesTarget(target: Identity) {
    let output: string | null;
    try {
      output = await pickDialog({
        kind: "save_file",
        title: "导出 Cookie",
        filter: "Cookie JSON (*.json)|*.json",
        defaultName: `${safeFileStem(target.name || target.id)}-cookies.json`,
        defaultDir: "downloads",
      });
    } catch (e) { dialogs.showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy(`cookies-${target.id}`, async () => {
      const result = await exportCookies(target.id, output!);
      await dialogs.showMessage({
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
    } catch (e) { dialogs.showError(e, "无法打开文件选择窗口"); return; }
    if (!chosen) return;
    await withBusy("import-file", async () => {
      const imported = await importPack(chosen!);
      await loadData();
      await dialogs.showMessage({
        tone: "success",
        title: "身份导入完成",
        message: `已导入环境「${imported.name || imported.id}」。`,
      });
    }, "导入身份失败");
  }

  const importArchive = (file: string) => withBusy(`import-${file}`, async () => {
    const imported = await importPack(file);
    await loadData();
    await dialogs.showMessage({
      tone: "success",
      title: "身份导入完成",
      message: `已导入环境「${imported.name || imported.id}」。`,
    });
  }, "导入身份失败");

  async function ensureAllStopped(actionLabel: string): Promise<boolean> {
    const active = identities.filter((it) => it.running || it.status === "starting").length;
    if (active === 0) return true;
    const { confirmed } = await dialogs.showConfirm({
      title: `有 ${active} 个环境正在运行`,
      message: `${actionLabel}前需要先停止所有正在运行的浏览器。是否立即全部停止？`,
      confirmLabel: "全部停止并继续",
      danger: true,
    });
    if (!confirmed) return false;
    await withBusy("stop-all", async () => { await stopAllIdentities(); }, "停止失败");
    return true;
  }

  async function exportAll() {
    if (!(await ensureAllStopped("导出全部数据"))) return;
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
    } catch (e) { dialogs.showError(e, "无法打开保存窗口"); return; }
    if (!output) return;
    await withBusy("export-all", async () => {
      const result = await exportAllData(output!);
      await loadData();
      await dialogs.showMessage({
        tone: "success",
        title: "全部数据导出完成",
        message: `已打包 ${result.files} 个文件（包含全部环境、账号密码、订阅与设置）。`,
        filePath: result.archive,
      });
    }, "导出全部数据失败");
  }

  async function importAll() {
    if (!(await ensureAllStopped("导入全部数据"))) return;
    let chosen: string | null;
    try {
      chosen = await pickDialog({
        kind: "open_file",
        title: "导入全部数据",
        filter: "Cacer 数据包 (*.zip)|*.zip|所有文件 (*.*)|*.*",
        defaultDir: "downloads",
      });
    } catch (e) { dialogs.showError(e, "无法打开文件选择窗口"); return; }
    if (!chosen) return;
    const { confirmed } = await dialogs.showConfirm({
      title: "确认导入全部数据",
      message: "导入会覆盖同名环境、订阅与设置。确定继续吗？",
      confirmLabel: "开始导入",
      danger: true,
    });
    if (!confirmed) return;
    await withBusy("import-all", async () => {
      const result = await importAllData(chosen!);
      await loadData();
      await dialogs.showMessage({
        tone: "success",
        title: "数据导入完成",
        message: `已恢复 ${result.files} 个文件到数据目录。`,
        filePath: result.data,
      });
    }, "导入全部数据失败");
  }

  async function cloneTarget(target: Identity) {
    const result = await dialogs.showPrompt({
      title: "复制为新环境",
      fields: [{ key: "name", label: "新环境名称", defaultValue: `${target.name}-副本`, required: true }],
      confirmLabel: "复制",
    });
    if (!result?.name) return;
    await withBusy(`clone-${target.id}`, async () => {
      await cloneIdentity(target.id, result.name);
      if (editTarget?.id === target.id) setEditTarget(null);
      dialogs.showToast(`已复制为「${result.name}」`);
    }, "复制环境失败");
  }

  async function saveEdit() {
    if (!editTarget) return;
    const target = editTarget;
    const live = !!target.running || target.status === "starting";
    const fingerprintChanged = (editForm.os ?? "") !== target.os || (editForm.country ?? "") !== target.country;
    if (!live && fingerprintChanged) {
      const { confirmed } = await dialogs.showConfirm({
        title: "确认重建设备指纹",
        message: "修改国家或系统会生成新的设备指纹并清空浏览器缓存，原有 Cookie 和登录状态可能失效。",
        confirmLabel: "继续保存",
        danger: true,
      });
      if (!confirmed) return;
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
    }, "保存失败");
  }

  async function remove(it: Identity) {
    const { confirmed, checked } = await dialogs.showConfirm({
      title: "删除环境",
      message: `确定删除「${it.name}」吗？`,
      confirmLabel: "删除",
      danger: true,
      checkboxLabel: "同时彻底清除该环境的本地浏览器缓存与登录数据（不可恢复）",
      checkboxDefault: false,
    });
    if (!confirmed) return;
    await withBusy(`del-${it.id}`, async () => {
      await deleteIdentity(it.id, checked);
      dialogs.showToast(checked ? `已彻底删除「${it.name}」` : `已移除「${it.name}」`);
    }, "删除失败");
  }

  async function stopAll() {
    const active = identities.filter((it) => it.running || it.status === "starting").length;
    if (active === 0) return;
    const { confirmed } = await dialogs.showConfirm({
      title: "停止全部运行中环境",
      message: `当前有 ${active} 个浏览器环境正在运行，确定全部关闭吗？`,
      confirmLabel: "全部停止",
      danger: true,
    });
    if (!confirmed) return;
    await withBusy("stop-all", async () => {
      const res = await stopAllIdentities();
      dialogs.showToast(`已停止 ${res.count} 个环境`);
    }, "停止失败");
  }

  function handleReorder(nextIds: string[]) {
    const byId = new Map(identities.map((it) => [it.id, it]));
    setIdentities(nextIds.map((id) => byId.get(id)).filter((it): it is Identity => !!it));
    reorderIdentities(nextIds).then(() => refresh(true)).catch((e) => { dialogs.showError(e, "排序保存失败"); refresh(true); });
  }

  const valid = form.name.trim().length > 0 && (netChoice === "direct" || (netChoice === "sub" ? !!form.proxy_source && !!form.proxy_node : !!form.proxy_server?.trim()));
  const editBusy = !!editTarget && ["cookies", "export", "clone", "edit"].some((action) => busy.has(`${action}-${editTarget.id}`));
  const editLive = !!editTarget?.running || editTarget?.status === "starting";
  const editValid = (editForm.name ?? "").trim().length > 0 && (editLive || editNetChoice === "direct" || (editNetChoice === "sub" ? !!editForm.proxy_source && !!editForm.proxy_node : !!(editForm.proxy_server ?? "").trim()));

  const runningList = identities.filter((it) => it.running || it.status === "starting");
  const proxyEnvs = identities.filter((it) => it.network_mode === "proxy");

  return (
    <main className="app-shell">
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
          <a className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => openSettings(environment && !environment.ready ? "runtime" : "data")}>
            <Icon>⚙</Icon>设置
            {((environment && !environment.ready) || update?.available) && <i className="nav-badge-dot" />}
          </a>
        </nav>
        <button
          type="button"
          className={`sidebar-bottom ${environment && !environment.ready ? "service-warning" : ""}`}
          disabled={checkingEnvironment}
          onClick={() => environment?.ready ? checkEnvironment() : openSettings("runtime")}
          title={environment?.checks.map((item) => `${item.label}：${item.ok ? "正常" : "待处理"}`).join("\n") || "检查本机运行环境"}
        >
          <i className="health-dot" />
          <div>
            <strong aria-live="polite">{checkingEnvironment ? "正在检测…" : environment?.ready ? "本地服务正常" : "需要检查环境"}</strong>
            <span>Cacer {appVersion}{!checkingEnvironment && !environment?.ready && " · 前往配置"}</span>
          </div>
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span><b>/</b><strong>{VIEW_LABEL[view]}</strong></div>
          <div className="top-actions">
            {update?.available && (
              <button className="icon-button update-button" title={`发现新版本 ${update.latest}`} onClick={() => setShowUpdate(true)}>
                ⤓<i className="update-dot" />
              </button>
            )}
            <button className="icon-button" title="刷新" onClick={() => refresh(true)}>↻</button>
          </div>
        </header>

        <div className="content">
          {environment && !environment.ready && view !== "settings" && (
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

          {view === "environments" && (
            <EnvironmentsView
              identities={identities}
              busy={busy}
              onCreate={openCreate}
              onImport={importIdentityFile}
              onLaunch={(id) => withBusy(`launch-${id}`, () => launchPrepared(id), "启动失败")}
              onStop={(id) => withBusy(`stop-${id}`, () => stopIdentity(id), "停止失败")}
              onStopAll={stopAll}
              onEdit={openEdit}
              onClone={cloneTarget}
              onExport={exportTarget}
              onExportCookies={exportCookiesTarget}
              onDelete={remove}
              onReorder={handleReorder}
              onShowNoteTip={showNoteTip}
              onHideNoteTip={hideNoteTip}
            />
          )}

          {view === "settings" && (
            <SettingsView
              tab={settingsTab}
              onTab={setSettingsTab}
              appVersion={appVersion}
              update={update}
              checkingUpdate={checkingUpdate}
              onCheckUpdate={manualCheckUpdate}
              onOpenUpdate={() => setShowUpdate(true)}
              dataInfo={dataInfo}
              busy={busy}
              onOpenDataDir={openDataFolder}
              onRefreshData={loadData}
              onExportAll={exportAll}
              onImportAll={importAll}
              onImportIdentityFile={importIdentityFile}
              onImportArchive={importArchive}
              onRevealPack={(p) => revealPath(p).catch((e) => dialogs.showError(e))}
              environment={environment}
              runtimeBusy={runtimeBusy}
              updateBusy={!!updateState?.busy}
              pythonPath={pythonPath}
              onPythonPath={setPythonPath}
              manualOpen={manualOpen}
              onManualOpen={setManualOpen}
              guideText={guideText}
              copied={copied}
              onEnvAction={handleEnvAction}
              onSetupLocal={() => void setupLocalRuntime()}
              onBrowsePython={browsePython}
              onApplyPython={applyPython}
              onOpenFonts={() => setView("fonts")}
              onRecheckEnv={checkEnvironment}
              onResetProxy={clearDownloadProxy}
              onCopyGuide={copyGuide}
              onDownloadStandalone={() => void setupRuntime("python")}
            />
          )}

          {view === "overview" && (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">DASHBOARD</div><h1>总览</h1></div>
                <button className="primary large" onClick={openCreate}>＋ 新建环境</button>
              </div>
              <section className="stats">
                <button type="button" className="stat-card clickable" onClick={() => setView("environments")}><span className="stat-icon purple">▦</span><div><span>全部环境</span><strong>{identities.length}</strong></div></button>
                <button type="button" className="stat-card clickable" onClick={() => setView("environments")}><span className="stat-icon green">●</span><div><span>正在运行</span><strong>{runningList.length}</strong></div></button>
                <button type="button" className="stat-card clickable" onClick={() => setView("proxy")}><span className="stat-icon blue">⌁</span><div><span>已配置代理</span><strong>{proxyEnvs.length}</strong></div></button>
                <button type="button" className="stat-card clickable" onClick={() => openSettings("runtime")}><span className="stat-icon orange">✓</span><div><span>服务状态</span><strong className="status-text">{environment?.ready ? "正常" : "待检查"}</strong></div></button>
              </section>
              <section className="panel panel-pad">
                <div className="section-title-row block-title-row">
                  <h3 className="block-title">正在运行的浏览器</h3>
                  {runningList.length > 0 && (
                    <PendingButton className="secondary danger-text compact-btn" onClick={stopAll} disabled={busy.size > 0} busy={busy.has("stop-all")} idle="全部停止" pending="停止中…" />
                  )}
                </div>
                {runningList.length === 0
                  ? <div className="empty-mini">当前没有运行中的浏览器环境。</div>
                  : <div className="sub-list">{runningList.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.network_mode === "direct" ? "直连" : it.proxy_node ?? it.proxy_server ?? "代理"}</span></div><span className={`status ${it.status === "starting" ? "starting" : "online"}`}><i />{it.status === "starting" ? "启动中" : "运行中"}</span></div>)}</div>}
              </section>
              <section className="panel panel-pad">
                <h3 className="block-title">快速操作</h3>
                <div className="settings-actions">
                  <button className="secondary" onClick={openCreate}>新建环境</button>
                  <PendingButton className="secondary" onClick={importIdentityFile} disabled={busy.size > 0} busy={busy.has("import-file")} idle="导入身份 (.sfx)" pending="导入中…" />
                  <button className="secondary" onClick={() => openSettings("data")}>数据备份与迁移</button>
                  <button className="secondary" onClick={() => setView("proxy")}>代理订阅</button>
                  <button className="secondary" onClick={() => setView("history")}>启动记录</button>
                </div>
              </section>
            </>
          )}

          {view === "fonts" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">FONT LIBRARY</div>
                  <div className="heading-with-tip"><h1>字体库</h1><InfoTip text="按环境所需字形分包下载，已缓存字体在所有环境中共享。选择具体环境时还会核对界面语言和系统指纹所需字形，英语环境也可能用到中日韩字体。" /></div>
                </div>
                <div className="heading-actions">
                  <button className="secondary" onClick={() => void importOfflineFontZip()} disabled={runtimeBusy}>导入本地离线包</button>
                  <button className="secondary" onClick={() => void openRuntimeDownloadsDir().catch((e) => dialogs.showError(e))}>打开缓存目录</button>
                  <button className="secondary" onClick={loadFontPlan} disabled={runtimeBusy || fontLoading}>刷新索引</button>
                </div>
              </div>
              <section className="panel font-panel">
                <div className="grid">
                  <label><span>按环境检查</span><select value={fontIdentity} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontIdentity(e.target.value); setFontCountry(""); }}><option value="">选择环境…</option>{identities.map((it) => <option key={it.id} value={it.id}>{it.name || it.id} · {it.country} · {OS_LABELS[it.os] ?? it.os}</option>)}</select></label>
                  <label><span>按国家 / 地区预下载</span><select value={fontCountry} disabled={runtimeBusy} onChange={(e) => { setFontPlan(null); setFontCountry(e.target.value); setFontIdentity(""); }}>{COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{value ? label : "仅公共字体"}</option>)}</select></label>
                </div>
                {fontLoading && <div className="form-progress">正在读取环境的字体需求…</div>}
                {fontPlan?.development && <div className="empty-mini compact-empty">当前开发环境直接使用本地引擎字体。</div>}
                {fontPlan && !fontPlan.development && <>
                  <div className="font-summary"><strong>{fontPlan.packs.filter((pack) => pack.cached).length} / {fontPlan.packs.length} 个包已缓存</strong><span>当前缺少 {fontPlan.packs.filter((pack) => pack.required && !pack.cached).length} 个所需包 · 需下载 {formatSize(fontPlan.missing_size)}</span></div>
                  <div className="settings-actions">
                    <button className="primary" disabled={runtimeBusy || fontLoading || fontPlan.ready} onClick={() => setupRuntime("fonts", fontPlan.packs.filter((pack) => pack.required).map((pack) => pack.id))}>下载当前所需</button>
                    <button className="secondary" disabled={runtimeBusy || fontLoading || !selectedFonts.length} onClick={() => setupRuntime("fonts", selectedFonts)}>下载勾选项</button>
                    <button className="secondary" disabled={runtimeBusy || fontLoading || fontPlan.packs.every((pack) => pack.cached)} onClick={() => setupRuntime("fonts", fontPlan.packs.map((pack) => pack.id))}>全部下载（{formatSize(fontPlan.packs.filter((pack) => !pack.cached).reduce((sum, pack) => sum + pack.size, 0))}）</button>
                  </div>
                  <div className="sub-list">{fontPlan.packs.map((pack) => <label className="sub-row font-row" key={pack.id}>
                    <input type="checkbox" checked={selectedFonts.includes(pack.id)} disabled={pack.cached || runtimeBusy || fontLoading} onChange={(e) => setSelectedFonts(e.target.checked ? [...selectedFonts, pack.id] : selectedFonts.filter((id) => id !== pack.id))} />
                    <div className="sub-info"><strong>{pack.name}</strong><span>{pack.count ? `${pack.count} 个文件 · ` : ""}{formatSize(pack.size)} 下载 · {formatSize(pack.unpacked_size)} 解压</span></div>
                    <span className={pack.cached ? "font-cached" : "font-missing"}>{pack.cached ? "已缓存" : pack.required ? "当前需要" : "可选"}</span>
                  </label>)}</div>
                </>}
              </section>
            </>
          )}

          {view === "proxy" && (
            <>
              <div className="page-heading"><div><div className="eyebrow">PROXY MANAGER</div><h1>代理管理</h1></div></div>
              <section className="panel panel-pad">
                <SectionTitle tip="订阅节点依赖 mihomo 内核。可将 mihomo.exe 放入软件目录的 tools 文件夹，或手动选择路径；Clash Verge 自带的 mihomo 也会自动识别。">
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
              </section>
              <section className="panel panel-pad">
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
              </section>
              <section className="panel panel-pad">
                <h3 className="block-title">环境代理分配</h3>
                {proxyEnvs.length === 0
                  ? <div className="empty-mini">暂无使用代理的环境。</div>
                  : <div className="sub-list">{proxyEnvs.map((it) => <div className="sub-row" key={it.id}><div className="sub-info"><strong>{it.name || it.id}</strong><span>{it.proxy_node ?? it.proxy_server ?? "代理"}{it.proxy_source ? ` · ${it.proxy_source}` : ""}</span></div><span className={`status ${it.running ? "online" : "offline"}`}><i />{it.running ? "运行中" : "已停止"}</span></div>)}</div>}
              </section>
            </>
          )}

          {view === "extensions" && (
            <>
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
            </>
          )}

          {view === "history" && (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">LAUNCH LOG</div><h1>启动记录</h1></div>
                <button className="secondary" onClick={loadHistory}>刷新</button>
              </div>
              <section className="panel">
                {history.length === 0
                  ? <div className="empty"><div className="empty-mark">◷</div><h3>暂无启动记录</h3><p>启动任意环境后，这里会显示时间、网络方式与事件。</p></div>
                  : <div className="table-wrap"><table><thead><tr><th>时间</th><th>环境</th><th>事件</th><th>网络</th></tr></thead><tbody>{history.map((item, index) => <tr key={`${item.at}-${item.id}-${index}`}><td>{item.at}</td><td><div className="profile-cell"><div><strong>{item.name || item.id}</strong><span>{item.id}</span></div></div></td><td><span className={`status ${item.event === "launch" ? "online" : "offline"}`}><i />{EVENT_LABEL[item.event] ?? item.event}</span></td><td>{item.network ?? "—"}</td></tr>)}</tbody></table></div>}
              </section>
            </>
          )}
        </div>
      </section>

      {runtimeBusy && downloadState && (
        <DownloadProgress state={downloadState} onCancel={() => cancelRuntime().catch((e) => dialogs.showError(e))} />
      )}

      {showCreate && (
        <Modal title="新建浏览器环境" backdropClose={false} closeDisabled={busy.has("create")} onClose={() => { if (!busyRef.current.has("create")) setShowCreate(false); }}>
          <div className="preset-bar">
            <span className="preset-label">快速预设</span>
            {CREATE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`preset-chip ${form.os === preset.os && form.country === preset.country ? "active" : ""}`}
                onClick={() => setForm({ ...form, os: preset.os, country: preset.country })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <IdentityFormFields
            data={formDataFromCreate(form)}
            netChoice={netChoice}
            sources={proxySourceList}
            nodes={subNodes}
            onChange={(patch) => setForm({
              ...form,
              ...(patch.name !== undefined && { name: patch.name }),
              ...(patch.note !== undefined && { note: patch.note }),
              ...(patch.os !== undefined && { os: patch.os || null }),
              ...(patch.country !== undefined && { country: patch.country || null }),
              ...(patch.ui_locale !== undefined && { ui_locale: patch.ui_locale }),
              ...(patch.memory_cache !== undefined && { memory_cache: patch.memory_cache }),
              ...(patch.proxy_node !== undefined && { proxy_node: patch.proxy_node || null }),
              ...(patch.proxy_server !== undefined && { proxy_server: patch.proxy_server }),
            })}
            onNetChoice={setNetChoice}
            onSelectSource={(src) => chooseSubSource(src, false)}
            onImportSubscription={() => void importBy("url")}
          />
          <div className="modal-footer">
            <button className="secondary" disabled={busy.has("create")} onClick={() => setShowCreate(false)}>取消</button>
            <PendingButton className="primary" disabled={!valid} busy={busy.has("create")} onClick={create} idle="生成环境" pending="生成中…" />
          </div>
        </Modal>
      )}

      {editTarget && (
        <Modal title="编辑环境" backdropClose={false} closeDisabled={editBusy} onClose={() => { if (!editBusy) setEditTarget(null); }}>
          <section className="edit-section">
            <SectionTitle tip="设备指纹默认保持不变，以维持 Cookie 和登录状态一致性。在浏览器内保存的网站密码也随本环境一并打包，可在地址栏输入 about:logins 管理。">
              身份指纹
            </SectionTitle>
            <div className="fpinfo">
              <span><Flag country={editTarget.country} size={16} /> {editTarget.country || "自动地区"}</span>
              <span>{OS_ICONS[editTarget.os]} {OS_LABELS[editTarget.os] ?? editTarget.os}</span>
              <span>◷ {editTarget.timezone}</span>
              <span>文 {editTarget.languages?.[0] ?? editTarget.locale}</span>
            </div>
          </section>
          <IdentityFormFields
            data={formDataFromEdit(editForm)}
            netChoice={editNetChoice}
            locked={editLive}
            sources={proxySourceList}
            nodes={editSubNodes}
            onChange={(patch) => setEditForm({
              ...editForm,
              ...(patch.name !== undefined && { name: patch.name }),
              ...(patch.note !== undefined && { note: patch.note }),
              ...(patch.os !== undefined && { os: patch.os || null }),
              ...(patch.country !== undefined && { country: patch.country || null }),
              ...(patch.ui_locale !== undefined && { ui_locale: patch.ui_locale }),
              ...(patch.memory_cache !== undefined && { memory_cache: patch.memory_cache }),
              ...(patch.proxy_node !== undefined && { proxy_node: patch.proxy_node }),
              ...(patch.proxy_server !== undefined && { proxy_server: patch.proxy_server }),
            })}
            onNetChoice={setEditNetChoice}
            onSelectSource={(src) => chooseSubSource(src, true)}
            onImportSubscription={() => void importBy("url")}
          />
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
              <PendingButton className="secondary" onClick={() => exportCookiesTarget(editTarget)} disabled={editBusy} busy={busy.has(`cookies-${editTarget.id}`)} idle="导出 Cookie" pending="导出中…" />
              <PendingButton className="secondary" onClick={() => exportTarget(editTarget)} disabled={editLive || editBusy} busy={busy.has(`export-${editTarget.id}`)} idle="导出身份" pending="导出中…" />
              <PendingButton className="secondary" onClick={() => cloneTarget(editTarget)} disabled={editLive || editBusy} busy={busy.has(`clone-${editTarget.id}`)} idle="复制为新环境" pending="复制中…" />
            </div>
            <div className="edit-save-actions">
              <button className="secondary" disabled={editBusy} onClick={() => setEditTarget(null)}>取消</button>
              <PendingButton className="primary" disabled={editBusy || !editValid} busy={busy.has(`edit-${editTarget.id}`)} onClick={saveEdit} idle="保存修改" pending="保存中…" />
            </div>
          </div>
        </Modal>
      )}

      {fontLaunchPrompt && (
        <Modal title="补齐环境所需字体" onClose={() => setFontLaunchPrompt(null)}>
          <p className="dialog-text">
            启动「{fontLaunchPrompt.name}」前需要下载以下配套字体（共 {formatSize(fontLaunchPrompt.plan.missing_size)}），下载后所有环境均可复用：
          </p>
          <div className="sub-list">
            {fontLaunchPrompt.plan.packs.filter((p) => p.required && !p.cached).map((pack) => (
              <div className="sub-row" key={pack.id}>
                <div className="sub-info">
                  <strong>{pack.name}</strong>
                  <span>{pack.count ? `${pack.count} 个文件 · ` : ""}{formatSize(pack.size)}</span>
                </div>
                <span className="font-missing">需要下载</span>
              </div>
            ))}
          </div>
          <div className="modal-footer">
            <button className="secondary" onClick={() => setFontLaunchPrompt(null)}>取消</button>
            <button className="secondary" onClick={() => { setFontIdentity(fontLaunchPrompt.id); setFontLaunchPrompt(null); setView("fonts"); }}>前往字体库</button>
            <button className="primary" disabled={runtimeBusy} onClick={confirmFontDownloadAndLaunch}>下载并启动</button>
          </div>
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
              ? <button className="secondary" onClick={() => cancelUpdate().catch((e) => dialogs.showError(e))}>取消下载</button>
              : <><button className="secondary" onClick={() => setShowUpdate(false)}>稍后</button><button className="primary" onClick={() => startUpdate()}>下载并安装</button></>}
          </div>
        </Modal>
      )}

      {showProxy && (
        <Modal title="下载线路不可用" onClose={() => { if (!proxyTesting) setShowProxy(false); }} closeDisabled={proxyTesting}>
          <section className="edit-section">
            {proxyStep === "ask"
              ? <p className="dialog-text">已依次尝试内置镜像和系统代理仍无法连接。是否手动设置代理后重试？</p>
              : <>
                <label className="edit-field">
                  <span>HTTP / SOCKS5 代理地址</span>
                  <div className="path-picker-row">
                    <input
                      autoFocus
                      value={proxyValue}
                      disabled={proxyTesting}
                      onChange={(e) => { setProxyValue(e.target.value); setProxyCheck(null); }}
                      placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                    />
                    <PendingButton
                      type="button"
                      className="secondary"
                      busy={proxyTesting}
                      disabled={!proxyValue.trim()}
                      onClick={() => void checkProxyConnectivity()}
                      idle="测试代理"
                      pending="检测中…"
                    />
                  </div>
                </label>
                {proxyCheck && (
                  <div className={`proxy-check-result ${proxyCheck.ok ? "ok" : "bad"}`}>
                    <span>{proxyCheck.ok ? "✓" : "!"}</span>
                    <span>{proxyCheck.text}</span>
                  </div>
                )}
              </>}
          </section>
          <div className="modal-footer">
            <button className="secondary" disabled={proxyTesting} onClick={() => { proxyRetry.current = null; setShowProxy(false); }}>取消</button>
            {proxyFallbackKind && (
              <button className="secondary" disabled={proxyTesting} onClick={() => openManualGuide(proxyFallbackKind)}>
                {proxyFallbackKind === "fonts" ? "手动下载 / 导入离线包" : "查看手动安装方式"}
              </button>
            )}
            <button className="secondary" disabled={proxyTesting} onClick={() => void applyProxy(true)}>重置代理重试</button>
            {proxyStep === "ask"
              ? <button className="primary" onClick={() => setProxyStep("input")}>设置代理</button>
              : <PendingButton className="primary" busy={proxyTesting} disabled={!proxyValue.trim()} onClick={() => void applyProxy()} idle="检测并重试" pending="检测中…" />}
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
            </> : (() => {
              const info = failedFontInfo ?? fontPlan;
              const targetIds = new Set(failedFontIds.length ? [...failedFontIds, "base"] : []);
              const missingPacks = (info?.packs ?? []).filter((p) => !p.cached && (targetIds.size === 0 ? p.required : targetIds.has(p.id)));
              const downloadsDir = info?.downloads_dir ?? "";
              return <>
                <p className="dialog-text">
                  字体自动下载失败。可用浏览器或下载工具手动下载下方压缩包，保持原文件名放入缓存目录，或直接点「导入本地 ZIP」自动校验安装：
                </p>
                {missingPacks.length > 0 && (
                  <div className="sub-list">
                    {missingPacks.map((pack) => (
                      <div className="sub-row font-manual-row" key={pack.id}>
                        <div className="sub-info">
                          <strong>{pack.name} · {pack.file ?? `${pack.id}.zip`}（{formatSize(pack.size)}）</strong>
                          {pack.url && <a className="font-url-link" href={pack.url} target="_blank" rel="noreferrer">{pack.url}</a>}
                        </div>
                        {pack.url && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => { void copyText(pack.url!); dialogs.showToast(`已复制 ${pack.file ?? pack.name} 下载链接`); }}
                          >
                            复制链接
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {downloadsDir && (
                  <div className="dialog-path-box">
                    <span className="manual-dir-label">离线包存放目录（放入后点「重新尝试安装」自动识别）：</span>
                    <code>{downloadsDir}</code>
                    <div className="dialog-path-actions">
                      <button type="button" className="secondary" onClick={() => void openRuntimeDownloadsDir().catch((e) => dialogs.showError(e))}>打开存放目录</button>
                      <button type="button" className="secondary" onClick={() => { void copyText(downloadsDir); dialogs.showToast("已复制目录路径"); }}>复制目录</button>
                    </div>
                  </div>
                )}
              </>;
            })()}
          </section>
          <div className="modal-footer">
            {(failedTask === "python" || failedTask === "local-python") && <button className="secondary" onClick={copyGuide}>{copied ? "已复制" : "复制安装命令"}</button>}
            {failedTask === "local-python" && <button className="secondary" onClick={() => { setFailedTask(null); void setupRuntime("python"); }}>改用独立运行时（备用）</button>}
            {failedTask === "fonts" && <>
              <button className="secondary" onClick={() => void importOfflineFontZip(failedFontIds)}>导入本地 ZIP</button>
              <button className="primary" onClick={() => { setFailedTask(null); void setupRuntime("fonts", failedFontIds); }}>重新尝试安装</button>
            </>}
            <button className="secondary" onClick={() => setFailedTask(null)}>关闭</button>
          </div>
        </Modal>
      )}

      {noteTip && <div className="note-tip" role="tooltip" style={{ left: noteTip.x, top: noteTip.y, transform: noteTip.above ? "translateY(calc(-100% - 8px))" : "none" }}>{noteTip.text}</div>}

      {dialogs.promptModal && <PromptDialog options={dialogs.promptModal.options} onResult={dialogs.resolvePrompt} />}
      {dialogs.confirmModal && <ConfirmDialog options={dialogs.confirmModal.options} onResult={dialogs.resolveConfirm} />}
      {dialogs.messageModal && <MessageDialog options={dialogs.messageModal.options} onClose={dialogs.closeMessage} />}
      <ToastHost items={dialogs.toasts} onDismiss={dialogs.dismissToast} />
    </main>
  );
}
