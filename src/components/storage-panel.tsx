"use client";

import { useEffect, useRef, useState } from "react";

import { formatBytes } from "@/lib/format.ts";

interface StorageUsage {
  database: {
    mainBytes: number;
    walBytes: number;
    shmBytes: number;
    totalBytes: number;
    path: string;
  };
  files: {
    totalBytes: number;
    fileCount: number;
    path: string;
    byKind: Array<{ kind: string; bytes: number; files: number }>;
  };
  totalBytes: number;
  counts: {
    sessions: number;
    requests: number;
    events: number;
    messages: number;
    toolCalls: number;
  };
  topSessions: Array<{ session_id: string; cwd: string; bytes: number }>;
}

interface StorageResponse {
  ok?: boolean;
  usage?: StorageUsage;
  error?: string;
}

const KIND_LABEL: Record<string, string> = {
  request: "模型请求",
  event: "钩子事件",
  message: "会话条目",
};

/** 存储用量面板：数据库与正文文件分别多少。 */
export function StoragePanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const usageRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/storage", { cache: "no-store" });
        const json = (await response.json()) as StorageResponse;
        if (!alive) return;
        if (json.ok === false || json.usage === undefined) {
          setError(json.error ?? "取不到存储用量。");
          return;
        }
        // 占用没变就不重绘：否则每 5 秒整块面板换一次，看着像页面在闪
        const fingerprint = JSON.stringify(json.usage);
        if (fingerprint !== usageRef.current) {
          usageRef.current = fingerprint;
          setUsage(json.usage);
        }
        setError(null);
      } catch (cause) {
        if (!alive) return;
        setError((cause as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (loading) return <div className="empty">正在统计…</div>;
  if (error !== null) return <div className="empty">{error}</div>;
  if (usage === null) return <div className="empty">没有数据。</div>;

  const percent = (bytes: number): string =>
    usage.totalBytes > 0 ? `${((bytes / usage.totalBytes) * 100).toFixed(1)}%` : "—";

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span>占用总览</span>
          <span className="count">每 5 秒刷新</span>
        </div>
        <div className="panel-body">
          <div className="grid-2">
            <div>
              <div className="label">数据库（索引）</div>
              <div className="storage-big">{formatBytes(usage.database.totalBytes)}</div>
              <div className="muted mono-dim">
                主库 {formatBytes(usage.database.mainBytes)} · WAL {formatBytes(usage.database.walBytes)} · 共享内存{" "}
                {formatBytes(usage.database.shmBytes)}
              </div>
              <div className="muted mono-dim" style={{ marginTop: 4 }}>
                {usage.database.path}
              </div>
            </div>
            <div>
              <div className="label">正文文件</div>
              <div className="storage-big">{formatBytes(usage.files.totalBytes)}</div>
              <div className="muted mono-dim">{usage.files.fileCount} 个文件</div>
              <div className="muted mono-dim" style={{ marginTop: 4 }}>
                {usage.files.path}
              </div>
            </div>
          </div>

          <div className="storage-bar" aria-hidden="true">
            <span style={{ width: percent(usage.database.totalBytes) }} className="db" />
            <span style={{ width: percent(usage.files.totalBytes) }} className="files" />
          </div>
          <div className="muted mono-dim" style={{ marginTop: 6 }}>
            合计 {formatBytes(usage.totalBytes)}：数据库 {percent(usage.database.totalBytes)}，正文文件{" "}
            {percent(usage.files.totalBytes)}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>正文文件按类型</span>
        </div>
        <div className="panel-body">
          <table className="table">
            <tbody>
              {usage.files.byKind.map((item) => (
                <tr key={item.kind}>
                  <td>{KIND_LABEL[item.kind] ?? item.kind}</td>
                  <td className="num">{item.files}</td>
                  <td className="num">{formatBytes(item.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>记录条数</span>
        </div>
        <div className="panel-body">
          <div className="grid-3">
            <div>
              <div className="label">会话</div>
              <div className="storage-num">{usage.counts.sessions}</div>
            </div>
            <div>
              <div className="label">模型请求</div>
              <div className="storage-num">{usage.counts.requests}</div>
            </div>
            <div>
              <div className="label">钩子事件</div>
              <div className="storage-num">{usage.counts.events}</div>
            </div>
            <div>
              <div className="label">会话条目</div>
              <div className="storage-num">{usage.counts.messages}</div>
            </div>
            <div>
              <div className="label">工具调用</div>
              <div className="storage-num">{usage.counts.toolCalls}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>占空间最多的会话</span>
          <span className="count">前 10</span>
        </div>
        <div className="panel-body">
          {usage.topSessions.length === 0 ? (
            <div className="empty">还没有会话。</div>
          ) : (
            <table className="table">
              <tbody>
                {usage.topSessions.map((item) => (
                  <tr key={item.session_id}>
                    <td className="mono-dim">{item.session_id}</td>
                    <td className="muted">{item.cwd}</td>
                    <td className="num">{formatBytes(item.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>导出</span>
          <span className="count">这期不做</span>
        </div>
        <div className="panel-body">
          <div className="muted">
            导出（打包 zip）还没有做。正文已经是独立文件，可以直接用系统工具打包：
          </div>
          <pre className="pre">cd {"<数据目录>"} && zip -r pi-observer-$(date +%Y%m%d).zip payloads</pre>
        </div>
      </div>
    </>
  );
}
