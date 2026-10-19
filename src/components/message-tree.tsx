"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { dateTime, formatBytes, shortId } from "@/lib/format.ts";
import { buildMessageTree, describeNode, visibleEntryIds, type TreeNode } from "@/lib/tree.ts";
import type { MessageDetail, MessageIndexRow } from "@/lib/types.ts";

interface MessageTreeProps {
  sessionId: string;
  /** 库里这一会话的条目索引（不含 payload） */
  initialMessages: MessageIndexRow[];
  /** 库里这一会话的条目总数；大于 `initialMessages.length` 说明树被截断了 */
  totalEntries: number;
}

/** 原始条目按这个长度截断着显示：单条 payload 最大 512 KB，整段塞进 DOM 会卡住页面 */
const RAW_JSON_CHARS = 20_000;

type DetailState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; detail: MessageDetail };

export function MessageTree({ sessionId, initialMessages, totalEntries }: MessageTreeProps) {
  const [messages, setMessages] = useState<MessageIndexRow[]>(initialMessages);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const tree = useMemo(() => buildMessageTree(messages), [messages]);
  const visible = useMemo(() => visibleEntryIds(tree, query), [tree, query]);

  // 默认停在当前分支的叶（文件里最后一条），和 Pi 一样落在会话的最新位置
  const activeId = selected ?? tree.currentLeafId;
  const active = activeId === null ? null : tree.byId.get(activeId) ?? null;

  useEffect(() => {
    if (activeId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });

    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages?entry=${encodeURIComponent(activeId)}`;
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { message?: MessageDetail; error?: string };
        if (cancelled) return;
        if (!response.ok || !body.message) {
          setDetail({ status: "error", reason: body.error ?? `HTTP ${response.status}` });
          return;
        }
        setDetail({ status: "ready", detail: body.message });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetail({ status: "error", reason: (error as Error).message });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, activeId]);

  /** 手动重读索引（页面加载时的回填已经把文件读过了） */
  const reload = useCallback(async () => {
    setReloading(true);
    setReloadError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { messages?: MessageIndexRow[]; error?: string };
      if (!response.ok || !body.messages) {
        setReloadError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setMessages(body.messages);
    } catch (error) {
      setReloadError((error as Error).message);
    } finally {
      setReloading(false);
    }
  }, [sessionId]);

  const context: RowContext = {
    activeId,
    visible,
    collapsed,
    select: setSelected,
    toggle: (entryId) => {
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
      });
    },
  };

  const filteredOut = visible !== null && visible.size === 0;
  const truncated = Math.max(totalEntries - messages.length, 0);

  return (
    <div className="panel message-tree">
      <div className="panel-head">
        <span>消息树</span>
        <span className="count">{`${tree.total} 条条目`}</span>
        <span className="spacer" />
        <span className="chip" onClick={() => void reload()} title="重读库里这一个会话的条目索引">
          <span className="k">R</span>
          {reloading ? "刷新中" : "刷新"}
        </span>
      </div>

      <div className="tree-search">
        <label className="input">
          <span style={{ color: "var(--fg-3)" }}>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="过滤节点…"
            aria-label="过滤消息树节点"
          />
        </label>
      </div>

      <div className="tree">
        {tree.total === 0 ? (
          <div className="faint" style={{ padding: "10px 12px" }}>
            这个会话在库里还没有条目。会话文件读不到或还没回填时就是这样，不是「没有消息」。
          </div>
        ) : null}
        {filteredOut ? (
          <div className="faint" style={{ padding: "10px 12px" }}>
            没有匹配的节点。
          </div>
        ) : null}
        {tree.roots.map((root) => (
          <TreeRow key={root.entry_id} node={root} context={context} />
        ))}
      </div>

      <div className="panel-head" style={{ borderTop: "1px solid var(--border)" }}>
        <span>选中节点</span>
        <span className="count">{active === null ? "—" : shortId(active.entry_id, 12)}</span>
      </div>

      <div className="panel-body">
        {active === null ? (
          <div className="faint">左边点一条条目，这里显示它的全文。</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11.5 }}>
              <span className="badge plain">{active.kind}</span>
              {active.role === null ? null : <span className="badge plain">{active.role}</span>}
              <span className="badge plain">{`第 ${active.entry_index} 行`}</span>
              <span className="faint">{dateTime(active.timestamp)}</span>
              <span className="faint">{formatBytes(active.payload_bytes)}</span>
              <span className={active.onCurrentBranch ? "badge info" : "badge plain"}>
                {active.onCurrentBranch ? "当前分支" : "非当前分支"}
              </span>
            </div>

            {detail === null || detail.status === "loading" ? (
              <div className="faint" style={{ marginTop: 8 }}>
                读取全文…
              </div>
            ) : null}

            {detail !== null && detail.status === "error" ? (
              <div className="pre err" style={{ marginTop: 8 }}>
                取不到这条条目的全文：{detail.reason}
              </div>
            ) : null}

            {detail !== null && detail.status === "ready" ? <MessageBody detail={detail.detail} /> : null}
          </>
        )}
      </div>

      <div className="panel-body" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.7 }}>
          节点来自会话文件里的 <code>id</code> / <code>parentId</code>（回填入库，只读）。
          <span style={{ color: "var(--green)" }}>⑂</span> 是分叉起点，
          <span className="faint">灰字「非当前分支」</span>表示它不在最后一条条目到根的父链上，
          <span style={{ color: "var(--amber)" }}>▣</span> 是压缩摘要。
          树是文件落盘后的快照：正在生成的消息要等写进文件、下一次刷新才出现。
          {truncated > 0 ? ` 这一页只渲染了前 ${messages.length} 条，文件里共 ${totalEntries} 条。` : ""}
          {tree.orphans > 0 ? ` 有 ${tree.orphans} 条条目的父条目不在索引里，已按根节点显示。` : ""}
          {reloadError === null ? "" : ` 上次刷新失败：${reloadError}`}
        </div>
      </div>
    </div>
  );
}

/** 详情：正文（回填时截到 2 KB）+ 原始条目 JSON */
function MessageBody({ detail }: { detail: MessageDetail }) {
  const raw = prettyJson(detail.payload);

  return (
    <>
      <div className="label" style={{ marginTop: 10 }}>
        正文
      </div>
      {detail.text === null || detail.text === "" ? (
        <div className="faint" style={{ marginTop: 4 }}>
          这条条目没有正文（回填时就没提取到，或本来就是空的）。
        </div>
      ) : (
        <div className="pre">{detail.text}</div>
      )}

      <div className="label" style={{ marginTop: 12 }}>
        原始条目
      </div>
      <div className="pre">{raw.text}</div>
      {raw.truncated ? (
        <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
          这里只显示前 {RAW_JSON_CHARS.toLocaleString("en-US")} 个字符；这条条目共 {formatBytes(detail.payload_bytes)}。
        </div>
      ) : null}
      {isTruncatedMarker(detail.payload) ? (
        <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
          这条条目的原文超过单条上限，库里只留了这条截断标记；会话文件里仍是完整的。
        </div>
      ) : null}
    </>
  );
}

function prettyJson(value: unknown): { text: string; truncated: boolean } {
  if (value === null || value === undefined) return { text: "（无）", truncated: false };
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    full = String(value);
  }
  if (full.length <= RAW_JSON_CHARS) return { text: full, truncated: false };
  return { text: `${full.slice(0, RAW_JSON_CHARS)}\n…`, truncated: true };
}

/** 回填时超过上限的条目存成 `{"truncated":true,"bytes":N}`（见 `backfill.ts`） */
function isTruncatedMarker(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { truncated?: unknown }).truncated === true
  );
}

interface RowContext {
  activeId: string | null;
  /** 过滤后应当显示的条目 id；null 表示不过滤 */
  visible: ReadonlySet<string> | null;
  collapsed: ReadonlySet<string>;
  select: (entryId: string) => void;
  toggle: (entryId: string) => void;
}

function TreeRow({ node, context }: { node: TreeNode; context: RowContext }) {
  if (context.visible !== null && !context.visible.has(node.entry_id)) return null;

  const display = describeNode(node);
  const hasChildren = node.children.length > 0;
  const closed = context.collapsed.has(node.entry_id);

  const classes = ["node-line"];
  if (node.entry_id === context.activeId) classes.push("active");
  if (!node.onCurrentBranch) classes.push("off-branch");

  return (
    <div className={closed ? "node closed" : "node"}>
      <div
        className={classes.join(" ")}
        onClick={() => context.select(node.entry_id)}
        title={`${node.kind}${node.role === null ? "" : ` · ${node.role}`} · 第 ${node.entry_index} 行 · ${node.entry_id}`}
      >
        <span
          className="twist"
          onClick={(event) => {
            if (!hasChildren) return;
            event.stopPropagation();
            context.toggle(node.entry_id);
          }}
        >
          {hasChildren ? (closed ? "▸" : "▾") : ""}
        </span>
        <span className={display.iconClass}>{display.glyph}</span>
        <span className="txt">{display.label}</span>
        {display.meta === null ? null : <span className="meta">{display.meta}</span>}
      </div>
      {hasChildren ? (
        <div className="node-children">
          {node.children.map((child) => (
            <TreeRow key={child.entry_id} node={child} context={context} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
