import type { ProxyNode, ProxySource } from "../api";
import { COUNTRY_OPTIONS, OS_OPTIONS } from "../constants";
import { FieldLabel, NodePicker, SectionTitle } from "./Ui";

export type NetChoice = "direct" | "sub" | "custom";

export interface IdentityFormData {
  name: string;
  note: string;
  os: string;
  country: string;
  ui_locale: string;
  memory_cache: boolean;
  proxy_source: string;
  proxy_node: string;
  proxy_server: string;
}

/// Shared form fields for both Create and Edit identity modals so OS, country,
/// language, memory cache, and proxy routing stay consistent in one place.
export function IdentityFormFields({
  data,
  netChoice,
  locked = false,
  sources,
  nodes,
  onChange,
  onNetChoice,
  onSelectSource,
  onImportSubscription,
}: {
  data: IdentityFormData;
  netChoice: NetChoice;
  locked?: boolean;
  sources: ProxySource[];
  nodes: ProxyNode[];
  onChange: (patch: Partial<IdentityFormData>) => void;
  onNetChoice: (choice: NetChoice) => void;
  onSelectSource: (source: string) => void;
  onImportSubscription?: () => void;
}) {
  return (
    <>
      <div className="grid">
        <label>
          <FieldLabel required>环境名称</FieldLabel>
          <input
            value={data.name}
            placeholder="例如：法国小店-A"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label>
          <span>备注</span>
          <textarea
            rows={2}
            value={data.note}
            placeholder="选填，支持换行"
            onChange={(e) => onChange({ note: e.target.value })}
          />
        </label>
        <label>
          <FieldLabel tip={locked ? "运行中不可修改设备系统，请先停止浏览器。" : "决定浏览器模拟的操作系统指纹。"}>
            设备系统
          </FieldLabel>
          <select value={data.os} disabled={locked} onChange={(e) => onChange({ os: e.target.value })}>
            {OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <FieldLabel tip={locked ? "运行中不可修改国家，请先停止浏览器。" : "语言、时区与设备指纹将自动跟随所选国家。"}>
            国家 / 地区
          </FieldLabel>
          <select value={data.country} disabled={locked} onChange={(e) => onChange({ country: e.target.value })}>
            {COUNTRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="wide">
          <FieldLabel tip="仅影响浏览器菜单与对话框显示，不改变网站识别到的语言和地区。选「跟随环境语言」时，日期与数字格式也与当地完全一致。">
            浏览器界面语言
          </FieldLabel>
          <select value={data.ui_locale} onChange={(e) => onChange({ ui_locale: e.target.value })}>
            <option value="zh-CN">中文（菜单显示中文）</option>
            <option value="">跟随环境语言（一致性最高）</option>
            {data.ui_locale && data.ui_locale !== "zh-CN" && (
              <option value={data.ui_locale}>当前：{data.ui_locale}</option>
            )}
          </select>
        </label>
        <label className="wide">
          <FieldLabel tip="允许浏览器在内存中复用已缓存资源，减少重复下载。修改后下次启动生效。">
            内存缓存
          </FieldLabel>
          <div className="seg">
            {([["on", "开启（推荐）"], ["off", "关闭"]] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={(!data.memory_cache) === (value === "off") ? "seg-on" : "seg-off"}
                onClick={() => onChange({ memory_cache: value === "on" })}
              >
                {label}
              </button>
            ))}
          </div>
        </label>
      </div>

      <section className="edit-section form-net-section">
        <SectionTitle tip={locked ? "浏览器运行中：名称、备注、语言、缓存和扩展开关可立即保存（下次启动生效）；网络与指纹设置需先停止浏览器。" : "代理修改在下次启动时生效，未写协议时默认按 HTTP 处理。"}>
          网络方式
        </SectionTitle>
        <div className="seg">
          {([["direct", "直连"], ["sub", "订阅节点"], ["custom", "手动代理"]] as const).map(([value, label]) => (
            <button
              type="button"
              disabled={locked}
              key={value}
              className={netChoice === value ? "seg-on" : "seg-off"}
              onClick={() => onNetChoice(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {netChoice === "sub" && (
          <div className="grid">
            <label className="wide">
              <div className="sub-label-bar">
                <FieldLabel tip="选择已导入的 Clash 代理订阅。">代理订阅</FieldLabel>
                {sources.length === 0 && onImportSubscription && !locked && (
                  <button type="button" className="inline-link-btn" onClick={onImportSubscription}>
                    ＋ 立即导入订阅
                  </button>
                )}
              </div>
              <select
                value={data.proxy_source}
                disabled={locked}
                onChange={(e) => onSelectSource(e.target.value)}
              >
                <option value="">{sources.length ? "选择订阅…" : "暂无订阅，可点右侧立即导入"}</option>
                {sources.map((s) => (
                  <option key={s.name} value={s.name}>{s.label}（{s.nodes} 个节点）</option>
                ))}
              </select>
            </label>
            <label className="wide">
              <span>节点</span>
              <NodePicker
                nodes={nodes}
                value={data.proxy_node}
                disabled={locked || !data.proxy_source}
                placeholder={data.proxy_source ? "选择节点…" : "请先选择订阅"}
                onChange={(node) => onChange({ proxy_node: node })}
              />
            </label>
          </div>
        )}
        {netChoice === "custom" && (
          <label className="edit-field">
            <FieldLabel tip="未写协议时默认按 HTTP 处理，也支持 socks5:// 等协议前缀。">代理服务器</FieldLabel>
            <input
              value={data.proxy_server}
              disabled={locked}
              placeholder="127.0.0.1:8080"
              onChange={(e) => onChange({ proxy_server: e.target.value })}
            />
          </label>
        )}
      </section>
    </>
  );
}
