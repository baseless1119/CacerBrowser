import { useEffect, useRef, useState } from "react";
import { revealPath } from "./api";

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export type DialogTone = "info" | "success" | "warning" | "error";

export interface MessageOptions {
  tone?: DialogTone;
  title: string;
  message: string;
  filePath?: string;
  confirmLabel?: string;
}

export interface ConfirmOptions {
  tone?: "warning" | "danger" | "info";
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  checkboxLabel?: string;
  checkboxDefault?: boolean;
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

export interface PromptField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

export interface PromptOptions {
  title: string;
  description?: string;
  fields: PromptField[];
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ToastItem {
  id: number;
  tone: DialogTone;
  text: string;
}

const TONE_ICON: Record<DialogTone, string> = {
  success: "✓",
  error: "!",
  warning: "!",
  info: "i",
};

function TopDialog({ label, onCancel, children }: { label: string; onCancel: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="overlay top-dialog-overlay"
      aria-label={label}
      style={{ border: 0, margin: 0, width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", boxSizing: "border-box", color: "inherit" }}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="dialog-card">{children}</div>
    </dialog>
  );
}

export function MessageDialog({
  options,
  onClose,
}: {
  options: MessageOptions;
  onClose: () => void;
}) {
  const tone = options.tone ?? "info";
  const [copied, setCopied] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  async function handleCopy() {
    if (!options.filePath) return;
    await copyText(options.filePath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function handleReveal() {
    if (!options.filePath) return;
    setRevealError(null);
    try {
      await revealPath(options.filePath);
    } catch (e) {
      setRevealError(String(e));
    }
  }

  return (
    <TopDialog label={options.title} onCancel={onClose}>
      <div className="dialog-body">
        <span className={`dialog-badge tone-${tone}`}>{TONE_ICON[tone]}</span>
        <div className="dialog-copy">
          <h3>{options.title}</h3>
          <p className="dialog-text">{options.message}</p>
          {options.filePath && (
            <div className="dialog-path-box">
              <code>{options.filePath}</code>
              <div className="dialog-path-actions">
                <button type="button" className="secondary" onClick={handleReveal}>打开所在文件夹</button>
                <button type="button" className="secondary" onClick={handleCopy}>{copied ? "已复制路径" : "复制路径"}</button>
              </div>
              {revealError && <div className="dialog-inline-error">{revealError}</div>}
            </div>
          )}
        </div>
      </div>
      <div className="dialog-footer">
        <button type="button" className="primary" autoFocus onClick={onClose}>
          {options.confirmLabel ?? "知道了"}
        </button>
      </div>
    </TopDialog>
  );
}

export function ConfirmDialog({
  options,
  onResult,
}: {
  options: ConfirmOptions;
  onResult: (result: ConfirmResult) => void;
}) {
  const [checked, setChecked] = useState(Boolean(options.checkboxDefault));
  const tone: DialogTone = options.danger || options.tone === "danger"
    ? "error"
    : options.tone === "info"
      ? "info"
      : "warning";

  return (
    <TopDialog label={options.title} onCancel={() => onResult({ confirmed: false, checked: false })}>
      <div className="dialog-body">
        <span className={`dialog-badge tone-${tone}`}>{TONE_ICON[tone]}</span>
        <div className="dialog-copy">
          <h3>{options.title}</h3>
          <p className="dialog-text">{options.message}</p>
          {options.checkboxLabel && (
            <label className="dialog-checkbox">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{options.checkboxLabel}</span>
            </label>
          )}
        </div>
      </div>
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={() => onResult({ confirmed: false, checked: false })}>
          {options.cancelLabel ?? "取消"}
        </button>
        <button
          type="button"
          className={options.danger ? "primary danger-primary" : "primary"}
          autoFocus
          onClick={() => onResult({ confirmed: true, checked })}
        >
          {options.confirmLabel ?? "确定"}
        </button>
      </div>
    </TopDialog>
  );
}

export function PromptDialog({
  options,
  onResult,
}: {
  options: PromptOptions;
  onResult: (values: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(options.fields.map((f) => [f.key, f.defaultValue ?? ""]))
  );

  const valid = options.fields.every((f) => !f.required || (values[f.key] ?? "").trim().length > 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    onResult(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  }

  return (
    <TopDialog label={options.title} onCancel={() => onResult(null)}>
      <form onSubmit={submit}>
        <div className="dialog-prompt-head">
          <h3>{options.title}</h3>
          {options.description && <p className="dialog-text">{options.description}</p>}
        </div>
        <div className="dialog-fields">
          {options.fields.map((field, index) => (
            <label key={field.key} className="edit-field">
              <span>{field.label}{field.required && <em> *</em>}</span>
              <input
                autoFocus={index === 0}
                value={values[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={() => onResult(null)}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {options.confirmLabel ?? "确定"}
          </button>
        </div>
      </form>
    </TopDialog>
  );
}

export function ToastHost({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el) return;
    if (items.length > 0) {
      try { el.showPopover?.(); } catch { /* fallback */ }
    } else {
      try { el.hidePopover?.(); } catch { /* ignore */ }
    }
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      // @ts-expect-error Popover attribute places toasts in top layer above open dialogs
      popover="manual"
      className="toast-host"
      aria-live="polite"
    >
      {items.map((item) => (
        <div key={item.id} className={`toast-item tone-${item.tone}`}>
          <span className="toast-icon">{TONE_ICON[item.tone]}</span>
          <span className="toast-text">{item.text}</span>
          <button type="button" className="toast-close" onClick={() => onDismiss(item.id)} aria-label="关闭">×</button>
        </div>
      ))}
    </div>
  );
}
