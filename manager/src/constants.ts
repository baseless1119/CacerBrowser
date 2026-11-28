import type { CreateRequest } from "./api";

export const APP_ICON = new URL("../app-icon.png", import.meta.url).href;

export const OS_OPTIONS = [
  { value: "", label: "自动匹配" },
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
] as const;

export const COUNTRY_OPTIONS = [
  ["", "自动选择"], ["US", "美国"], ["CA", "加拿大"], ["GB", "英国"],
  ["FR", "法国"], ["DE", "德国"], ["ES", "西班牙"], ["IT", "意大利"],
  ["NL", "荷兰"], ["SE", "瑞典"], ["CH", "瑞士"], ["AU", "澳大利亚"],
  ["JP", "日本"], ["KR", "韩国"], ["SG", "新加坡"], ["IN", "印度"],
  ["BR", "巴西"], ["CN", "中国"], ["TW", "中国台湾"], ["HK", "中国香港"],
] as const;

export const OS_LABELS: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
export const OS_ICONS: Record<string, string> = { windows: "▣", macos: "●", linux: "◆" };

export type View = "overview" | "environments" | "proxy" | "extensions" | "downloads" | "history" | "fonts" | "settings";
export type SettingsTab = "data" | "runtime" | "about";

export const VIEW_LABEL: Record<View, string> = {
  overview: "总览",
  environments: "浏览器环境",
  proxy: "代理管理",
  extensions: "扩展中心",
  downloads: "下载记录",
  history: "启动记录",
  fonts: "字体库",
  settings: "设置",
};

export const EVENT_LABEL: Record<string, string> = { launch: "启动", stop: "停止", closed: "关闭窗口" };
export const EXT_SOURCE_LABEL: Record<string, string> = { engine: "引擎内置", amo: "官方商店", local: "本地导入" };

export const CREATE_PRESETS = [
  { label: "美国 Windows", os: "windows", country: "US" },
  { label: "日本 macOS", os: "macos", country: "JP" },
  { label: "英国 Windows", os: "windows", country: "GB" },
  { label: "新加坡 Windows", os: "windows", country: "SG" },
  { label: "德国 Linux", os: "linux", country: "DE" },
] as const;

/// Sentinel shared with the Rust downloaders: every mirror and GitHub failed.
export const DOWNLOAD_ROUTES_FAILED = "所有下载线路均失败";

export function formatUsers(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万`;
  return String(count);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatStamp(seconds: number): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function safeFileStem(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|\.+$/g, "").trim();
  return cleaned || "identity";
}

export function inlineNote(note: string): string {
  return note.replace(/\s*\n+\s*/g, " ").trim();
}

export function cleanError(err: unknown): string {
  const text = String(err ?? "").trim();
  return text.replace(/^Error:\s*/i, "") || "操作失败";
}

const PREF_KEY = "cacer:last-create-prefs";

export function loadCreateDefaults(): CreateRequest {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<CreateRequest>;
      return {
        name: "",
        note: "",
        os: saved.os ?? "",
        country: saved.country ?? "",
        network: "direct",
        ui_locale: saved.ui_locale ?? "zh-CN",
        memory_cache: saved.memory_cache ?? true,
      };
    }
  } catch { /* ignore */ }
  return { name: "", note: "", os: "", country: "", network: "direct", ui_locale: "zh-CN", memory_cache: true };
}

export function saveCreateDefaults(form: CreateRequest): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      os: form.os ?? "",
      country: form.country ?? "",
      ui_locale: form.ui_locale ?? "zh-CN",
      memory_cache: form.memory_cache ?? true,
    }));
  } catch { /* ignore */ }
}
