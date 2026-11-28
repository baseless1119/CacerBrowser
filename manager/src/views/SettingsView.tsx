import type { DataOverview, EnvironmentCheck, UpdateInfo } from "../api";
import { formatSize, formatStamp, type SettingsTab } from "../constants";
import InfoTip from "../InfoTip";
import { EnvChecks, FieldLabel, PendingButton, SectionTitle, type EnvCardAction } from "../components/Ui";

export default function SettingsView(props: {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  appVersion: string;
  update: UpdateInfo | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
  onOpenUpdate: () => void;
  dataInfo: DataOverview | null;
  busy: Set<string>;
  onOpenDataDir: () => void;
  onRefreshData: () => void;
  onExportAll: () => void;
  onImportAll: () => void;
  onImportIdentityFile: () => void;
  onImportArchive: (name: string) => void;
  onRevealPack: (path: string) => void;
  environment: EnvironmentCheck | null;
  runtimeBusy: boolean;
  updateBusy: boolean;
  pythonPath: string;
  onPythonPath: (value: string) => void;
  manualOpen: boolean;
  onManualOpen: (open: boolean) => void;
  guideText: string;
  copied: boolean;
  onEnvAction: (action: EnvCardAction) => void;
  onSetupLocal: () => void;
  onBrowsePython: (kind: "dir" | "file", autoSetup: boolean) => void;
  onApplyPython: () => void;
  onOpenFonts: () => void;
  onRecheckEnv: () => void;
  onResetProxy: () => void;
  onCopyGuide: () => void;
  onDownloadStandalone: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>设置</h1>
        </div>
        <div className="settings-tabs" role="tablist">
          {([
            ["data", "数据与迁移"],
            ["runtime", "运行环境"],
            ["about", "更新与关于"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={props.tab === key}
              className={`settings-tab ${props.tab === key ? "active" : ""}`}
              onClick={() => props.onTab(key)}
            >
              {label}
              {key === "runtime" && props.environment && !props.environment.ready && <i className="tab-dot warn" />}
              {key === "about" && props.update?.available && <i className="tab-dot info" />}
            </button>
          ))}
        </div>
      </div>

      {props.tab === "data" && (
        <>
          <section className="panel panel-pad">
            <SectionTitle tip="环境配置、身份包、订阅与代理配置都保存在同一个数据目录，迁移时可整目录复制或使用下方备份功能。">
              数据目录
            </SectionTitle>
            <div className="data-line"><code>{props.dataInfo?.dir ?? "正在读取…"}</code></div>
            <div className="settings-actions">
              <button className="secondary" onClick={props.onOpenDataDir}>打开文件夹</button>
              <button className="secondary" onClick={props.onRefreshData}>刷新</button>
            </div>
          </section>

          <section className="panel panel-pad">
            <SectionTitle tip={"导出全部数据（.zip）：整机全量备份，含所有环境、账号密码、订阅、扩展与设置，导入时覆盖同名文件。\n导入/导出身份包（.sfx）：针对单个环境（含其指纹、Cookie 与密码），导入时新增环境不覆盖已有数据，适合单环境迁移或分享。"}>
              导入与导出
            </SectionTitle>
            <div className="settings-actions">
              <PendingButton className="primary" onClick={props.onExportAll} disabled={props.busy.size > 0} busy={props.busy.has("export-all")} idle="导出全部数据 (.zip)" pending="导出中…" />
              <PendingButton className="secondary" onClick={props.onImportAll} disabled={props.busy.size > 0} busy={props.busy.has("import-all")} idle="导入全部数据 (.zip)" pending="导入中…" />
              <PendingButton className="secondary" onClick={props.onImportIdentityFile} disabled={props.busy.size > 0} busy={props.busy.has("import-file")} idle="导入身份包 (.sfx)" pending="导入中…" />
            </div>
            {props.dataInfo && props.dataInfo.packs.length > 0 && (
              <>
                <div className="section-spacer" />
                <SectionTitle tip="保存在数据目录 packs 文件夹下的历史身份包，可快速导入或定位文件。">
                  已保存的身份包
                </SectionTitle>
                <div className="sub-list">
                  {props.dataInfo.packs.map((p) => (
                    <div className="sub-row" key={p.name}>
                      <div className="sub-info">
                        <strong>{p.name}</strong>
                        <span>{formatSize(p.size)} · {formatStamp(p.modified)}</span>
                      </div>
                      <div className="row-actions">
                        <button className="secondary" onClick={() => {
                          const sep = props.dataInfo!.packs_dir.endsWith("\\") ? "" : "\\";
                          props.onRevealPack(`${props.dataInfo!.packs_dir}${sep}${p.name}`);
                        }}>定位</button>
                        <PendingButton className="secondary" onClick={() => props.onImportArchive(p.name)} disabled={props.busy.size > 0} busy={props.busy.has(`import-${p.name}`)} idle="导入" pending="导入中…" />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}

      {props.tab === "runtime" && (
        <section className="panel panel-pad">
          <SectionTitle tip="优先复用本机已有 Python 创建独立虚拟环境并自动通过国内镜像或代理安装依赖，避免下载完整 Python 包；未检测到时可选择本地目录或按指引安装。">
            运行环境检查
          </SectionTitle>
          {props.environment && (
            <EnvChecks
              checks={props.environment.checks}
              pythonDetected={props.environment.python_detected}
              onAction={props.onEnvAction}
              busy={props.runtimeBusy}
            />
          )}
          <div className="settings-actions">
            {props.environment?.python_detected ? (
              <>
                {!props.environment.dependencies_ready && (
                  <button className="primary" disabled={props.runtimeBusy} onClick={props.onSetupLocal}>
                    一键安装依赖（复用本机 Python）
                  </button>
                )}
                <button className="secondary" disabled={props.runtimeBusy} onClick={() => props.onBrowsePython("dir", true)}>
                  选择其他 Python 目录
                </button>
              </>
            ) : (
              <>
                <button className="primary" disabled={props.runtimeBusy} onClick={() => props.onBrowsePython("dir", true)}>
                  选择本地 Python 目录
                </button>
                <button className="secondary" disabled={props.runtimeBusy} onClick={() => props.onBrowsePython("file", true)}>
                  选择 python.exe
                </button>
              </>
            )}
            <button className="secondary" onClick={props.onOpenFonts}>管理字体库</button>
            <button className="secondary" disabled={props.runtimeBusy} onClick={props.onRecheckEnv}>重新检查</button>
            <button className="secondary" disabled={props.runtimeBusy || props.updateBusy} onClick={props.onResetProxy}>重置下载代理</button>
          </div>

          <details className="compact-details" open={props.manualOpen} onToggle={(e) => props.onManualOpen(e.currentTarget.open)}>
            <summary>手动安装 Python / 指定本地目录</summary>
            <label className="edit-field">
              <FieldLabel tip="可选择或粘贴本机 Python 安装目录（或 python.exe 路径）。已有依赖将直接启用；缺依赖时自动基于该 Python 创建独立环境并安装。">
                Python 目录或 python.exe 路径
              </FieldLabel>
              <div className="path-picker-row">
                <input
                  value={props.pythonPath}
                  onChange={(e) => props.onPythonPath(e.target.value)}
                  placeholder="例如：C:\Python312 或 C:\…\python.exe"
                  disabled={props.runtimeBusy}
                />
                <button type="button" className="secondary" disabled={props.runtimeBusy} onClick={() => props.onBrowsePython("dir", false)}>选择目录</button>
                <button type="button" className="secondary" disabled={props.runtimeBusy} onClick={() => props.onBrowsePython("file", false)}>选择文件</button>
              </div>
            </label>
            <div className="settings-actions">
              <button className="primary" onClick={props.onApplyPython} disabled={props.runtimeBusy || !props.pythonPath.trim()}>
                使用此 Python（缺依赖时自动安装）
              </button>
            </div>
            <div className="manual-cmd-wrap">
              <div className="manual-cmd-head">
                <span>PowerShell 安装命令</span>
                <InfoTip text="如果本机尚未安装 Python，可将以下命令复制到 PowerShell 执行安装。" />
              </div>
              <pre className="cmd-block">{props.guideText}</pre>
            </div>
            <div className="settings-actions">
              <button className="secondary" onClick={props.onCopyGuide}>{props.copied ? "已复制" : "复制安装命令"}</button>
              <button className="secondary" disabled={props.runtimeBusy} onClick={props.onDownloadStandalone}>
                备用：下载独立运行时{props.environment?.python_size ? `（${formatSize(props.environment.python_size)}）` : ""}
              </button>
            </div>
          </details>
        </section>
      )}

      {props.tab === "about" && (
        <section className="panel panel-pad">
          <SectionTitle tip="启动时会自动静默检查 GitHub 最新版本；下载更新包时自动尝试内置镜像与系统代理，并校验 SHA256 摘要。">
            软件更新
          </SectionTitle>
          <div className="version-row">
            <span>
              当前版本 <strong>v{props.appVersion}</strong>
              {props.update?.available && <em className="version-new"> · 新版本 v{props.update.latest} 可用</em>}
            </span>
            <div className="row-actions">
              {props.update?.available && (
                <button className="primary" onClick={props.onOpenUpdate}>立即更新</button>
              )}
              <PendingButton className="secondary" onClick={props.onCheckUpdate} busy={props.checkingUpdate} idle="检查更新" pending="检查中…" />
            </div>
          </div>
          <div className="section-spacer" />
          <SectionTitle>关于与许可</SectionTitle>
          <p className="about-line">项目仓库：<a href="https://github.com/baseless1119/CacerBrowser" target="_blank" rel="noreferrer">github.com/baseless1119/CacerBrowser</a></p>
          <p className="about-line">Cacer 自定义软件许可 · 原创部分由著作权人保留全部权利。未经书面许可，禁止以商业目的重新打包或分发。第三方组件适用各自许可。</p>
        </section>
      )}
    </>
  );
}
