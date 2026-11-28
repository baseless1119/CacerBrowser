import type { DownloadRecord } from "../api";
import { formatSize } from "../constants";

interface DownloadsViewProps {
  items: DownloadRecord[];
  onRefresh: () => void;
  onClear: () => void;
  onReveal: (path: string) => void;
}

export default function DownloadsView({ items, onRefresh, onClear, onReveal }: DownloadsViewProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">DOWNLOADS</div>
          <h1>下载记录</h1>
        </div>
        <div className="row-actions">
          <button className="secondary" onClick={onRefresh}>刷新</button>
          {items.length > 0 && (
            <button className="secondary danger" onClick={onClear}>清空记录</button>
          )}
        </div>
      </div>
      <section className="panel">
        {items.length === 0 ? (
          <div className="empty">
            <div className="empty-mark">↓</div>
            <h3>暂无下载记录</h3>
            <p>在浏览器中下载文件后，这里会自动记录文件名、大小与保存位置，并支持一键定位文件夹。</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>文件</th>
                  <th>大小</th>
                  <th>来源环境</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="profile-cell">
                        <div>
                          <strong>{item.filename}</strong>
                          <span>{item.directory || "—"}</span>
                        </div>
                      </div>
                    </td>
                    <td>{item.size > 0 ? formatSize(item.size) : "—"}</td>
                    <td>{item.identity_name || item.identity_id || "—"}</td>
                    <td>
                      {item.status === "failed" ? (
                        <span className="status offline"><i />失败</span>
                      ) : item.exists ? (
                        <span className="status online"><i />已完成</span>
                      ) : (
                        <span className="status offline"><i />已移动/删除</span>
                      )}
                    </td>
                    <td>{item.at}</td>
                    <td>
                      <button
                        className="secondary"
                        disabled={!item.path && !item.directory}
                        onClick={() => onReveal(item.exists && item.path ? item.path : item.directory)}
                      >
                        {item.exists ? "定位文件" : "打开目录"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
