import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Identity } from "../api";
import { APP_ICON, OS_ICONS, OS_LABELS, inlineNote } from "../constants";
import Flag from "../Flag";
import InfoTip from "../InfoTip";
import { ButtonLabel, PendingButton } from "../components/Ui";

type FilterMode = "all" | "running" | "proxy";

export default function EnvironmentsView(props: {
  identities: Identity[];
  busy: Set<string>;
  onCreate: () => void;
  onImport: () => void;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onStopAll: () => void;
  onEdit: (it: Identity) => void;
  onClone: (it: Identity) => void;
  onExport: (it: Identity) => void;
  onExportCookies: (it: Identity) => void;
  onDelete: (it: Identity) => void;
  onReorder: (ids: string[]) => void;
  onShowNoteTip: (event: ReactMouseEvent<HTMLSpanElement>, note: string) => void;
  onHideNoteTip: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<{ id: string; x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const runningCount = props.identities.filter((it) => it.running || it.status === "starting").length;
  const proxyCount = props.identities.filter((it) => it.network_mode !== "direct").length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && menuOpen) {
        setMenuOpen(null);
      }
    };
    const onOutside = () => setMenuOpen(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onOutside);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onOutside);
    };
  }, [menuOpen]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return props.identities.filter((it) => {
      if (filter === "running" && !(it.running || it.status === "starting")) return false;
      if (filter === "proxy" && it.network_mode === "direct") return false;
      if (!q) return true;
      return [it.name, it.note, it.country, it.os, it.proxy_server ?? "", it.proxy_node ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [props.identities, search, filter]);

  const canDrag = !search.trim() && filter === "all" && props.identities.length > 1;

  function startDrag(event: DragEvent<HTMLTableRowElement>, id: string) {
    if (!canDrag) return;
    props.onHideNoteTip();
    setMenuOpen(null);
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
    const ids = props.identities.map((it) => it.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    props.onReorder(next);
  }
  function openRowMenu(event: ReactMouseEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    if (menuOpen?.id === id) {
      setMenuOpen(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 156;
    const menuHeight = 198;
    const x = Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12));
    const y = rect.bottom + menuHeight > window.innerHeight ? rect.top - menuHeight - 6 : rect.bottom + 6;
    setMenuOpen({ id, x, y });
  }

  const menuTarget = menuOpen ? props.identities.find((it) => it.id === menuOpen.id) ?? null : null;

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ENVIRONMENT MANAGER</div>
          <div className="heading-with-tip">
            <h1>浏览器环境</h1>
            <InfoTip text="每个环境拥有独立的设备指纹、Cookie、缓存与代理出口。点击环境名称可直接编辑，列表支持拖动排序（Ctrl+K 快速搜索）。" />
          </div>
        </div>
        <div className="heading-actions">
          {runningCount > 0 && (
            <PendingButton
              className="secondary danger-text"
              onClick={props.onStopAll}
              disabled={props.busy.size > 0}
              busy={props.busy.has("stop-all")}
              idle={`停止全部 (${runningCount})`}
              pending="停止中…"
            />
          )}
          <PendingButton className="secondary" onClick={props.onImport} disabled={props.busy.size > 0} busy={props.busy.has("import-file")} idle="导入身份" pending="导入中…" />
          <button className="primary large" onClick={props.onCreate}>＋ 新建环境</button>
        </div>
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="toolbar-left">
            <div className="search-box">
              <span>⌕</span>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称、国家或代理 (Ctrl+K)"
              />
              {search && (
                <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="清空搜索">×</button>
              )}
            </div>
            <div className="filter-pills" role="tablist" aria-label="按状态筛选">
              <button type="button" className={`filter-pill ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
                全部 <span>{props.identities.length}</span>
              </button>
              <button type="button" className={`filter-pill ${filter === "running" ? "active" : ""}`} onClick={() => setFilter("running")}>
                运行中 <span>{runningCount}</span>
              </button>
              <button type="button" className={`filter-pill ${filter === "proxy" ? "active" : ""}`} onClick={() => setFilter("proxy")}>
                代理 <span>{proxyCount}</span>
              </button>
            </div>
          </div>
          <div className="toolbar-right">
            <span className="result-count">显示 {visible.length} 项</span>
            {canDrag && <InfoTip text="拖动表格行可调整环境排序。" />}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <img className="empty-mark" src={APP_ICON} alt="" />
            <h3>{props.identities.length ? "没有匹配的环境" : "开始创建第一个环境"}</h3>
            <p>{props.identities.length ? "尝试切换筛选条件或清空搜索关键词。" : "创建独立浏览器身份，或直接导入已有 .sfx 身份包。"}</p>
            {props.identities.length ? (
              <div className="empty-actions">
                <button className="secondary" onClick={() => { setSearch(""); setFilter("all"); }}>重置筛选</button>
              </div>
            ) : (
              <div className="empty-actions">
                <button className="primary" onClick={props.onCreate}>＋ 新建环境</button>
                <PendingButton className="secondary" onClick={props.onImport} disabled={props.busy.size > 0} busy={props.busy.has("import-file")} idle="导入身份包" pending="导入中…" />
              </div>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>环境</th><th>状态</th><th>设备</th><th>网络</th><th>地区 / 语言</th><th className="actions-head">操作</th></tr>
              </thead>
              <tbody>
                {visible.map((it) => {
                  const live = it.running || it.status === "starting";
                  return (
                    <tr
                      key={it.id}
                      draggable={canDrag}
                      className={dragId === it.id ? "row-dragging" : dragOverId === it.id && dragId !== it.id ? "row-drop-target" : undefined}
                      onDragStart={(e) => startDrag(e, it.id)}
                      onDragOver={(e) => overRow(e, it.id)}
                      onDrop={(e) => dropRow(e, it.id)}
                      onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                    >
                      <td>
                        <div className="profile-cell">
                          <div className="country-avatar"><Flag country={it.country} size={26} /></div>
                          <div>
                            <button type="button" className="profile-name-btn" onClick={() => props.onEdit(it)} title="点击编辑环境">
                              {it.name || it.id}
                            </button>
                            <span onMouseEnter={(e) => props.onShowNoteTip(e, it.note)} onMouseLeave={props.onHideNoteTip}>
                              {inlineNote(it.note) || `创建于 ${it.created_at?.slice(0, 10) ?? "—"}`}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`status ${it.status === "starting" ? "starting" : it.running ? "online" : "offline"}`}>
                          <i />{it.status === "starting" ? "启动中" : it.running ? "运行中" : "已停止"}
                        </span>
                      </td>
                      <td><span className="device"><b>{OS_ICONS[it.os] ?? "◈"}</b>{OS_LABELS[it.os] ?? it.os}</span></td>
                      <td><span className="network" title={it.proxy_node ?? it.proxy_server ?? undefined}><i className={it.network_mode === "direct" ? "direct" : "proxy"} />{it.network_mode === "direct" ? "直连" : it.proxy_node ?? "代理"}</span></td>
                      <td><span className="locale"><Flag country={it.country} size={17} /> {it.country || "自动"}<small>{it.languages?.[0] ?? it.locale}</small></span></td>
                      <td>
                        <div className="table-actions">
                          {live
                            ? <button className="action stop-action" disabled={props.busy.has(`stop-${it.id}`) || props.busy.has(`launch-${it.id}`)} aria-busy={props.busy.has(`stop-${it.id}`)} onClick={() => props.onStop(it.id)}><ButtonLabel busy={props.busy.has(`stop-${it.id}`)} idle={it.status === "starting" ? "取消" : "停止"} pending={it.status === "starting" ? "取消中…" : "停止中…"} /></button>
                            : <button className="action launch-action" disabled={props.busy.has(`launch-${it.id}`) || props.busy.has(`stop-${it.id}`)} aria-busy={props.busy.has(`launch-${it.id}`)} onClick={() => props.onLaunch(it.id)}><ButtonLabel busy={props.busy.has(`launch-${it.id}`)} idle="启动" pending="启动中…" /></button>}
                          <button className="more-action" onClick={() => props.onEdit(it)}>编辑</button>
                          <button
                            type="button"
                            className={`more-action row-menu-btn ${menuOpen?.id === it.id ? "open" : ""}`}
                            aria-label="更多操作"
                            title="更多操作"
                            onClick={(e) => openRowMenu(e, it.id)}
                          >
                            ⋯
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {menuOpen && menuTarget && (
        <div
          className="row-menu"
          role="menu"
          style={{ left: menuOpen.x, top: menuOpen.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(null); props.onEdit(menuTarget); }}>
            编辑配置
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuTarget.running || menuTarget.status === "starting"}
            onClick={() => { setMenuOpen(null); props.onClone(menuTarget); }}
          >
            复制为新环境
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuTarget.running || menuTarget.status === "starting"}
            onClick={() => { setMenuOpen(null); props.onExport(menuTarget); }}
          >
            导出身份 (.sfx)
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(null); props.onExportCookies(menuTarget); }}>
            导出 Cookie (.json)
          </button>
          <div className="row-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={menuTarget.running || menuTarget.status === "starting"}
            onClick={() => { setMenuOpen(null); props.onDelete(menuTarget); }}
          >
            删除环境
          </button>
        </div>
      )}
    </>
  );
}
