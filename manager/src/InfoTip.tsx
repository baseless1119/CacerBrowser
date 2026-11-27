import { useEffect, useRef, useState } from "react";

interface TipPosition {
  x: number;
  y: number;
  above: boolean;
}

/// Compact "i" help badge: keeps forms and panels uncluttered while exposing
/// full details on hover/focus. Uses top-layer `popover="manual"` when
/// available so the bubble renders cleanly above open `<dialog>` modals and
/// never clips inside scrollable containers.
export default function InfoTip({ text, label = "查看说明" }: { text: string; label?: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TipPosition | null>(null);

  function show() {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 290;
    const x = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
    const above = rect.bottom + 140 > window.innerHeight && rect.top > 120;
    setPos({ x, y: above ? rect.top - 8 : rect.bottom + 8, above });
  }

  function hide() {
    setPos(null);
  }

  useEffect(() => {
    const el = popRef.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el) return;
    if (pos) {
      try { el.showPopover?.(); } catch { /* fallback to fixed positioning */ }
    } else {
      try { el.hidePopover?.(); } catch { /* ignore */ }
    }
  }, [pos]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="info-tip-btn"
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pos ? hide() : show(); }}
      >
        i
      </button>
      {pos && (
        <div
          ref={popRef}
          // @ts-expect-error Popover attribute is supported by WebView2 Chromium
          popover="manual"
          className="info-tip-bubble"
          role="tooltip"
          style={{
            left: pos.x,
            top: pos.y,
            transform: pos.above ? "translateY(-100%)" : "none",
          }}
        >
          {text}
        </div>
      )}
    </>
  );
}
