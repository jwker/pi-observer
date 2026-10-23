"use client";

import { useCallback, useEffect, useState } from "react";

interface ProbeStatus {
  probeDir: string;
  extensionPath: string;
  extensionExists: boolean;
  extensionOwned: boolean;
  codeInstalled: boolean;
  agentDir: string;
  dataDir: string;
  updatedAt: string | null;
}

interface ProbeResponse {
  ok?: boolean;
  status?: ProbeStatus;
  message?: string;
  error?: string;
  needsConfirm?: boolean;
  dataRemoved?: boolean;
}

/**
 * 探针的安装与卸载。
 *
 * 探针是 Pi 的扩展：装它就是往 Pi 的扩展目录里放一个入口文件。
 * 这是有副作用的操作，所以只在这里由人点，不在启动时自动做。
 */
export function ProbePanel() {
  const [status, setStatus] = useState<ProbeStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [removeData, setRemoveData] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/probe", { cache: "no-store" });
      const json = (await response.json()) as ProbeResponse;
      if (json.status !== undefined) setStatus(json.status);
      setError(json.error ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      setBusy(true);
      setMessage(null);
      setError(null);
      try {
        const response = await fetch("/api/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await response.json()) as ProbeResponse;
        if (json.status !== undefined) setStatus(json.status);
        if (json.needsConfirm === true) {
          setConfirmOverwrite(true);
          setMessage(json.message ?? "需要确认。");
        } else if (json.ok === false) {
          setError(json.error ?? json.message ?? "操作失败。");
        } else {
          setMessage(json.message ?? "完成。");
          setConfirmOverwrite(false);
          setRemoveData(false);
        }
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const installed = status !== null && status.extensionExists && status.extensionOwned;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span>探针（Pi 扩展）</span>
          <span className="count">{installed ? "已安装" : "未安装"}</span>
        </div>
        <div className="panel-body">
          <div className="muted">
            探针是 Pi 的扩展，负责把模型请求、工具调用这些运行时数据推给看板。
            装它等于往 Pi 的扩展目录里放一个入口文件——Pi 每次启动都会加载那个目录下的
            <code>.ts</code> / <code>.js</code> 文件。
          </div>
          {status !== null ? (
            <div className="muted mono-dim" style={{ marginTop: 8, lineHeight: 1.7 }}>
              <div>入口文件：{status.extensionPath}</div>
              <div>探针代码：{status.probeDir}</div>
              <div>
                状态：
                {status.extensionExists
                  ? status.extensionOwned
                    ? "入口文件在，是桌面版装的"
                    : "入口文件在，但不是桌面版装的（不会自动覆盖）"
                  : "入口文件不在"}
                {status.codeInstalled ? " · 探针代码已就位" : " · 探针代码没装"}
              </div>
              {status.updatedAt !== null ? <div>上次改动：{status.updatedAt}</div> : null}
            </div>
          ) : null}

          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act({ action: "install", overwrite: confirmOverwrite })}
            >
              {installed ? "重新安装" : "安装探针"}
            </button>
            <button
              className="btn"
              disabled={busy || (status !== null && !status.extensionExists && !status.codeInstalled)}
              onClick={() => void act({ action: "uninstall", removeData })}
            >
              卸载探针
            </button>
            <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={removeData}
                onChange={(event) => setRemoveData(event.target.checked)}
              />
              卸载时连数据一起删（历史不可恢复）
            </label>
          </div>

          {confirmOverwrite ? (
            <div className="notice warn" style={{ marginTop: 10 }}>
              <span className="ic">!</span>
              <div>
                入口文件不是桌面版装的，再点一次「安装」会覆盖它。
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setConfirmOverwrite(false)}>
                  算了
                </button>
              </div>
            </div>
          ) : null}

          {message !== null ? (
            <div className="notice" style={{ marginTop: 10 }}>
              <span className="ic">◌</span>
              <div>{message}</div>
            </div>
          ) : null}

          {error !== null ? (
            <div className="notice err" style={{ marginTop: 10 }}>
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
