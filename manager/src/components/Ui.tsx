import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { EnvironmentCheck, ProxyNode, RuntimeStatus } from "../api";
import { formatSize } from "../constants";
import InfoTip from "../InfoTip";

export function Icon({ children }: { children: ReactNode }) {
  return <span className="nav-icon">{children}</span>;
}

export function SectionTitle({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <div className="section-title-row">
      <h4>{children}</h4>
      {tip && <InfoTip text={tip} />}
    </div>
  );
}

export function FieldLabel({ children, tip, required }: { children: ReactNode; tip?: string; required?: boolean }) {
  return (
    <span className="field-label-row">
      <span>{children}{required && <em> *</em>}</span>
      {tip && <InfoTip text={tip} />}
    </span>
  );
}

export function ButtonLabel({ busy, idle, pending }: { busy: boolean; idle: string; pending: string }) {
  return (
    <span className="button-label">
      <span className="button-label-size" aria-hidden="true">{idle}</span>
      <span className="button-label-size" aria-hidden="true"><span className="button-spinner" />{pending}</span>
      <span className="button-label-content">
        {busy && <span className="button-spinner" aria-hidden="true" />}
        {busy ? pending : idle}
      </span>
    </span>
  );
}

export function PendingButton({ busy, idle, pending, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-busy"> & {
  busy: boolean; idle: string; pending: string;
}) {
  return (
    <button {...props} disabled={disabled || busy} aria-busy={busy}>
      <ButtonLabel busy={busy} idle={idle} pending={pending} />
    </button>
  );
}

export type EnvCardAction = "local-python" | "pick-dir" | "manual" | "engine";

export function EnvChecks(props: {
  checks: EnvironmentCheck["checks"];
  pythonDetected?: boolean;
  onAction?: (action: EnvCardAction) => void;
  busy?: boolean;
}) {
  return (
    <div className="env-checks">
      {props.checks.map((check) => (
        <div className={`env-card ${check.ok ? "ok" : "bad"}`} key={check.key}>
          <span className="env-mark">{check.ok ? "✓" : "!"}</span>
          <div className="env-copy">
            <strong>{check.label}</strong>
            <p>{check.detail}</p>
          </div>
          {!check.ok && props.onAction && check.key === "dependencies" && props.pythonDetected && (
            <button className="primary env-action env-action-primary" disabled={props.busy} onClick={() => props.onAction?.("local-python")}>
              一键安装依赖
            </button>
          )}
          {!check.ok && props.onAction && check.key === "python" && (
            <div className="env-actions">
              <button className="primary env-action env-action-primary" disabled={props.busy} onClick={() => props.onAction?.("pick-dir")}>
                选择本地目录
              </button>
              <button className="secondary env-action" disabled={props.busy} onClick={() => props.onAction?.("manual")}>
                手动安装
              </button>
            </div>
          )}
          {!check.ok && props.onAction && check.key === "engine" && (
            <button className="secondary env-action" disabled={props.busy} onClick={() => props.onAction?.("engine")}>
              重新安装说明
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/// Top-layer runtime progress card so progress stays visible above open modals.
export function DownloadProgress({ state, onCancel }: { state: RuntimeStatus; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el) return;
    try { el.showPopover?.(); } catch { /* fallback */ }
    return () => { try { el.hidePopover?.(); } catch { /* ignore */ } };
  }, []);

  const hasBytes = state.total > 0 && state.downloaded > 0;
  const pct = hasBytes ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : 0;

  return (
    <div
      ref={ref}
      // @ts-expect-error Popover places the progress card in the top layer above modals
      popover="manual"
      className="download-toast"
      role="status"
    >
      <div className="download-toast-head">
        <strong>{cancelling ? "正在取消…" : "正在准备运行资源"}</strong>
        <button
          type="button"
          className="icon-button"
          title="取消任务"
          disabled={cancelling}
          onClick={() => { setCancelling(true); onCancel(); }}
        >
          ×
        </button>
      </div>
      <p>{cancelling ? "正在中止连接并清理临时文件…" : state.message}</p>
      {state.total > 0 ? (
        hasBytes ? (
          <>
            <progress max={state.total} value={state.downloaded} />
            <span>{pct}% · {formatSize(state.downloaded)} / {formatSize(state.total)}</span>
          </>
        ) : (
          <>
            <progress />
            <span>正在连接 · 共 {formatSize(state.total)}</span>
          </>
        )
      ) : (
        <progress />
      )}
    </div>
  );
}

/// Searchable dropdown for subscriptions that carry 50–200+ proxy nodes.
export function NodePicker({
  nodes,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  nodes: ProxyNode[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) => `${n.name} ${n.type}`.toLowerCase().includes(q));
  }, [nodes, filter]);

  return (
    <div className="node-picker">
      {nodes.length > 10 && !disabled && (
        <input
          type="text"
          className="node-filter-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`筛选节点（共 ${nodes.length} 个，如 日本 / HK / IEPL）…`}
        />
      )}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {value && !filtered.some((n) => n.name === value) && (
          <option value={value}>{value}</option>
        )}
        {filtered.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}{n.type ? ` · ${n.type}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
