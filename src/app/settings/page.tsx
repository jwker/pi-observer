import { ProbePanel } from "@/components/probe-panel.tsx";
import { StoragePanel } from "@/components/storage-panel.tsx";

export const dynamic = "force-dynamic";

/**
 * 设置页：存储用量。
 *
 * 正文改成存文件之后，数据库只剩索引，占用可以忽略；真正占地方的是
 * `data/payloads/`。这一页把两边分别列清楚，导出功能这期不做。
 */
export default function SettingsPage() {
  return (
    <div className="page narrow">
      <div className="page-head">
        <div className="title">
          <h1>设置</h1>
          <div className="crumb">
            <a href="/">← 回到看板</a>
          </div>
        </div>
      </div>

      <ProbePanel />
      <StoragePanel />
    </div>
  );
}
