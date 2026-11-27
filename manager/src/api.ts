import { invoke } from "@tauri-apps/api/core";

export interface Identity {
  id: string;
  name: string;
  note: string;
  os: string;
  country: string;
  locale: string;
  timezone: string;
  languages: string[];
  created_at: string;
  network_mode: string;
  proxy_server: string | null;
  proxy_source: string | null;
  proxy_node: string | null;
  ui_locale: string | null;
  memory_cache: boolean;
  disabled_extensions: string[];
  running: boolean;
  status?: "stopped" | "starting" | "running" | string;
  pid: number | null;
}

export interface CreateRequest {
  name: string;
  note?: string;
  os: string | null;
  country: string | null;
  network: string;
  proxy_server?: string | null;
  proxy_source?: string | null;
  proxy_node?: string | null;
  ui_locale?: string;
  memory_cache?: boolean;
}

export interface ProxySource {
  name: string;
  label: string;
  path: string;
  updated_at: string;
  nodes: number;
}

export interface ProxyNode {
  name: string;
  type: string;
}

export interface ProxyCore {
  found: boolean;
  path: string | null;
}

export interface ProxyOverview {
  sources: ProxySource[];
  core: ProxyCore;
}

export interface ImportedSubscription {
  name: string;
  label: string;
  path: string;
  nodes: ProxyNode[];
  count: number;
}

export interface ClashConfig {
  name: string;
  file: string;
  path: string;
  nodes: number;
}

export interface SystemProxy {
  enabled: boolean;
  server: string;
}

export interface RuntimeStatus {
  busy: boolean;
  message: string;
  downloaded: number;
  total: number;
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_status");
}
export async function installRuntime(kind: "python" | "fonts", proxy: string, fontIds: string[] = []): Promise<{ path: string }> {
  return invoke("install_runtime", { kind, proxy, fontIds });
}
export interface DownloadSettings { proxy: string; mirror: string }
export const downloadSettings = () => invoke<DownloadSettings>("download_settings");
export const saveDownloadSettings = (settings: DownloadSettings) => invoke<void>("save_download_settings", { settings });
export interface FontPack {
  id: string; name: string; count: number; size: number; unpacked_size: number;
  cached: boolean; required: boolean;
}
export interface FontOverview {
  development: boolean; ready: boolean; packs: FontPack[]; missing_size: number;
}
export const fontOverview = (identityId?: string, country?: string) =>
  invoke<FontOverview>("font_overview", { identityId: identityId || null, country: country || null });
export async function cancelRuntime(): Promise<void> {
  return invoke("cancel_runtime");
}
export async function selectPython(path: string): Promise<EnvironmentCheck> {
  return invoke("select_python", { path });
}
export async function setupLocalPython(path?: string | null, proxy = ""): Promise<{ path: string; environment: EnvironmentCheck }> {
  return invoke("setup_local_python", { path: path?.trim() || null, proxy });
}
export async function pickPythonPath(kind: "dir" | "file"): Promise<string | null> {
  return invoke("pick_python_path", { kind });
}

export interface EnvironmentCheck {
  ready: boolean;
  python_detected: boolean;
  python_path: string | null;
  python_version: string | null;
  dependencies_ready: boolean;
  fonts_ready: boolean;
  python_size: number | null;
  fonts_size: number | null;
  manual_commands: string;
  root: string;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
}

export interface DataPack {
  name: string;
  size: number;
  modified: number;
}

export interface DataOverview {
  dir: string;
  packs_dir: string;
  packs: DataPack[];
}

export interface HistoryItem {
  at: string;
  event: "launch" | "stop" | "closed" | string;
  id: string;
  name: string;
  network?: string;
}

export async function environmentCheck(): Promise<EnvironmentCheck> {
  return await invoke<EnvironmentCheck>("environment_check");
}

export async function listIdentities(): Promise<Identity[]> {
  return await invoke<Identity[]>("list_identities");
}

export async function createIdentity(req: CreateRequest): Promise<Identity> {
  return await invoke<Identity>("create_identity", { req });
}

export interface EditRequest {
  name?: string;
  note?: string;
  network?: string;
  proxy_server?: string;
  proxy_source?: string;
  proxy_node?: string;
  clear_proxy?: boolean;
  ui_locale?: string;
  memory_cache?: boolean;
  disabled_extensions?: string[];
  os?: string | null;
  country?: string | null;
}

export async function editIdentity(id: string, req: EditRequest): Promise<Identity> {
  return await invoke<Identity>("edit_identity", { id, req });
}

export async function reorderIdentities(ids: string[]): Promise<{ order: string[] }> {
  return await invoke<{ order: string[] }>("reorder_identities", { ids });
}

export async function exportPack(id: string, name: string): Promise<{ archive: string; file: string; id: string }> {
  return await invoke("export_pack", { id, name });
}

export async function importPack(file: string): Promise<Identity> {
  return await invoke<Identity>("import_pack", { file });
}

export async function exportAllData(archive: string): Promise<{ archive: string; files: number }> {
  return await invoke("export_all_data", { archive });
}

export async function importAllData(archive: string): Promise<{ archive: string; files: number; data: string }> {
  return await invoke("import_all_data", { archive });
}

export async function dataOverview(): Promise<DataOverview> {
  return await invoke<DataOverview>("data_overview");
}

export async function openDataDir(): Promise<{ dir: string }> {
  return await invoke("open_data_dir");
}

export async function launchHistory(limit = 100): Promise<{ items: HistoryItem[] }> {
  return await invoke("launch_history", { limit });
}

export async function exportCookies(id: string, output: string): Promise<{ archive: string; id: string; count: number }> {
  return await invoke("export_cookies", { id, output });
}

export async function rebuildIdentity(id: string, os: string, country: string): Promise<Identity> {
  return await invoke<Identity>("rebuild_identity", { id, os, country });
}

export async function cloneIdentity(id: string, name: string): Promise<Identity> {
  return await invoke<Identity>("clone_identity", { id, name });
}

export async function deleteIdentity(id: string, purge: boolean): Promise<void> {
  await invoke("delete_identity", { id, purge });
}

export async function launchIdentity(id: string): Promise<void> {
  await invoke("launch_identity", { id });
}

export async function stopIdentity(id: string): Promise<void> {
  await invoke("stop_identity", { id });
}

export async function systemProxy(): Promise<SystemProxy> {
  return await invoke<SystemProxy>("system_proxy");
}

export async function proxySources(): Promise<ProxyOverview> {
  return await invoke<ProxyOverview>("proxy_sources");
}

export async function proxyNodes(source: string): Promise<{ source: string; nodes: ProxyNode[] }> {
  return await invoke("proxy_nodes", { source });
}

export async function proxyImport(kind: "file" | "url" | "text", value: string, name = "", label = ""): Promise<ImportedSubscription> {
  return await invoke<ImportedSubscription>("proxy_import", { kind, value, name, label });
}

export async function proxyRename(source: string, label: string): Promise<{ name: string; label: string }> {
  return await invoke("proxy_rename", { source, label });
}

export async function proxyDelete(source: string): Promise<void> {
  await invoke("proxy_delete", { source });
}

export async function proxySetCore(path: string): Promise<ProxyCore> {
  return await invoke<ProxyCore>("proxy_set_core", { path });
}

export async function clashConfigs(): Promise<{ configs: ClashConfig[] }> {
  return await invoke("clash_configs");
}

// ---------------------------------------------------------- extension center

export interface ExtensionItem {
  slug: string;
  addon_id: string;
  name: string;
  summary: string;
  version: string;
  source: "engine" | "amo" | "local" | string;
  installed_at: string;
  icon: string;
  engine: boolean;
  removable: boolean;
  present: boolean;
}

export interface ExtensionSearchResult {
  slug: string;
  name: string;
  summary: string;
  version: string;
  icon: string;
  users: number;
  rating: number;
  author: string;
  homepage: string;
  installed: boolean;
}

export async function extList(): Promise<{ extensions: ExtensionItem[] }> {
  return await invoke("ext_list");
}

export async function extSearch(query: string, limit = 20): Promise<{ query: string; results: ExtensionSearchResult[] }> {
  return await invoke("ext_search", { query, limit });
}

export async function extInstall(slug: string): Promise<ExtensionItem> {
  return await invoke("ext_install", { slug });
}

export async function extImport(path: string): Promise<ExtensionItem> {
  return await invoke("ext_import", { path });
}

export async function extRemove(slug: string): Promise<{ slug: string; removed: boolean }> {
  return await invoke("ext_remove", { slug });
}

// ------------------------------------------------------------ self update

export interface UpdateInfo {
  current: string;
  latest: string;
  notes: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
  available: boolean;
}

export interface UpdateStatus {
  busy: boolean;
  message: string;
  downloaded: number;
  total: number;
}

export const checkUpdate = () => invoke<UpdateInfo>("check_update");
export const downloadUpdate = () => invoke<string>("download_update");
export const updateStatus = () => invoke<UpdateStatus>("update_status");
export const cancelUpdate = () => invoke<void>("cancel_update");
export const installUpdate = () => invoke<void>("install_update");
