/**
 * 单页时间线的行模型（R2，纯函数）。
 *
 * 输入是 `queries.sessionStreamData` 取到的原始行，输出按「用户 Turn」分组的行：
 *
 *   - 一个 Turn = 一条用户消息 + 它之后、下一条用户消息之前的全部条目；
 *   - 当前分支由 `tree.ts` 判断，旁支条目仍然返回，但标 `onCurrentBranch=false`，
 *     界面默认隐藏，切「其它分支」时再显示；
 *   - 文件条目（消息 / 工具调用）与钩子事件是两类来源：前者 `fromFile=true`，
 *     后者 `fromFile=false`；工具起止、provider 请求/响应等钩子事件只作为
 *     对应行的「关联事件」，不再单独占一行，避免同一件事渲染两次；
 *   - 行顺序只按时间与稳定次序排，不按渲染需要重排；界面把 Turn 倒序展示，
 *     但每个 Turn 内部仍是从旧到新，读起来是顺着发生的。
 *
 * 分页只按 Turn 算：`turnWindow(stream, pages, 20)` 返回最近 N 页的正序 Turn，
 * 界面反转后显示。`sessionStreamData` 已经把一行会话的数据取全，分页在内存里做。
 */
import { buildMessageTree } from "./tree.ts";
import type { MessageTree, TreeNode } from "./tree.ts";
import type {
  EventRow,
  RequestIndexRow,
  SessionStreamData,
  TimelineMessageRow,
  ToolCallIndexRow,
  TurnRow,
} from "./types.ts";

export type StreamCategory = "msg" | "session" | "run" | "tool" | "model" | "probe";

export type StreamRowKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "event"
  | "request"
  | "response"
  | "pending";

/**
 * 时间线的一行。字段按来源取用，没用到的是 null / 空数组；
 * 详情弹窗用 `entryId` / `toolCallId` / `requestSeq` / `eventId` 去按需取全文。
 */
export interface StreamRow {
  key: string;
  kind: StreamRowKind;
  category: StreamCategory;
  at: string | null;
  label: string;
  text: string | null;
  thinking: string | null;
  /** true = 内容来自会话文件；false = 钩子事件 / 请求记录 */
  fromFile: boolean;
  entryId: string | null;
  resultEntryId: string | null;
  parentId: string | null;
  childIds: string[];
  entryIndex: number | null;
  payloadBytes: number;
  onCurrentBranch: boolean;
  forkPoint: boolean;
  branchStart: boolean;
  orphan: boolean;
  toolCallId: string | null;
  toolName: string | null;
  /** 助手行上的工具名，用来画行内小标签 */
  toolNames: string[];
  argsPreview: string | null;
  argsBytes: number;
  resultPreview: string | null;
  resultBytes: number | null;
  toolError: boolean;
  durationMs: number | null;
  requestSeq: number | null;
  eventId: string | null;
  eventType: string | null;
  status: number | null;
  /** 与这一行对应的钩子事件（工具起止、provider 请求/响应） */
  relatedEventIds: string[];
}

export interface StreamTurnStats {
  toolCount: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StreamTurn {
  key: string;
  kind: "turn" | "prelude";
  /** 用户 Turn 的序号，从 1 开始；prelude 为 null */
  index: number | null;
  summary: string;
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
  failed: boolean;
  stopReason: string | null;
  /** 正序：同一 Turn 内从旧到新 */
  rows: StreamRow[];
  stats: StreamTurnStats;
  /** 这个 Turn 覆盖的条目 id（含 toolResult 与旁支条目） */
  entryIds: string[];
  /** `run_seq:turn_index`，用于把事件 / 请求 / 工具挂回 Turn */
  turnKeys: string[];
  /** 挂在这个 Turn 上的全部事件 id（含不单独成行的钩子事件） */
  eventIds: string[];
  onCurrentBranch: boolean;
}

export interface SessionStream {
  /** 第一条用户消息之前的条目（会话头、系统提示、模型切换等） */
  prelude: StreamTurn | null;
  /** 用户 Turn，正序（旧 → 新） */
  turns: StreamTurn[];
  branch: {
    entries: number;
    current: number;
    offCurrent: number;
    forks: number;
    orphans: number;
  };
  running: boolean;
}

export interface TurnWindow {
  /** 正序的一页；界面反转后显示 */
  turns: StreamTurn[];
  /** 只有加载到最早一页时才返回 prelude */
  prelude: StreamTurn | null;
  hasEarlier: boolean;
  total: number;
  pageSize: number;
  loaded: number;
}

const HIDDEN_EVENT_TYPES = new Set([
  "tool_execution_start",
  "tool_execution_end",
  "provider_request",
  "provider_response",
  "model_select",
  "thinking_level_select",
  "agent_start",
  "agent_end",
  "session_compact",
  // v2 探针留下的事件：v3 已不推送；旧库在 7 天保留期内还会读到，不能在时间线上重复成行
  "message_start",
  "message_update",
  "message_end",
  "message_progress",
  "turn_start",
  "turn_end",
]);

export function buildSessionStream(data: SessionStreamData): SessionStream {
  const messages = [...data.messages].sort((a, b) => a.entry_index - b.entry_index);
  const tree = buildMessageTree(
    messages.map((entry) => ({
      entry_id: entry.entry_id,
      parent_id: entry.parent_id,
      kind: entry.kind,
      role: entry.role,
      timestamp: entry.timestamp,
      entry_index: entry.entry_index,
      summary: entry.text,
      payload_bytes: entry.payload_bytes,
    })),
  );
  const branch = tree.currentBranch;

  const assistantEntryIds = new Set(
    messages
      .filter((entry) => entry.kind === "message" && entry.role === "assistant")
      .map((entry) => entry.entry_id),
  );

  const toolsByEntry = new Map<string, ToolCallIndexRow[]>();
  const unlinkedTools: ToolCallIndexRow[] = [];
  for (const tool of data.tools) {
    if (tool.entry_id !== null && assistantEntryIds.has(tool.entry_id)) {
      const list = toolsByEntry.get(tool.entry_id);
      if (list === undefined) toolsByEntry.set(tool.entry_id, [tool]);
      else list.push(tool);
    } else {
      unlinkedTools.push(tool);
    }
  }
  for (const list of toolsByEntry.values()) {
    list.sort((a, b) => (a.started_at ?? a.ended_at ?? "").localeCompare(b.started_at ?? b.ended_at ?? ""));
  }
  unlinkedTools.sort((a, b) => (a.started_at ?? a.ended_at ?? "").localeCompare(b.started_at ?? b.ended_at ?? ""));

  const turns: StreamTurn[] = [];
  let prelude: StreamTurn | null = null;
  let currentTurn: StreamTurn | null = null;
  let turnIndex = 0;

  const ensurePrelude = (): StreamTurn => {
    if (prelude === null) prelude = newTurn(null, null);
    return prelude;
  };

  const addEntryToTurn = (turn: StreamTurn, entry: TimelineMessageRow) => {
    turn.entryIds.push(entry.entry_id);
    if (branch.has(entry.entry_id)) turn.onCurrentBranch = true;
    turn.startedAt = minTime(turn.startedAt, entry.timestamp);
    turn.endedAt = maxTime(turn.endedAt, entry.timestamp);
  };

  const addRow = (turn: StreamTurn, row: StreamRow) => {
    turn.rows.push(row);
    turn.startedAt = minTime(turn.startedAt, row.at);
    turn.endedAt = maxTime(turn.endedAt, row.at);
    if (row.onCurrentBranch) turn.onCurrentBranch = true;
  };

  for (const entry of messages) {
    const isUser = entry.kind === "message" && entry.role === "user";
    if (isUser) {
      currentTurn = newTurn(entry, ++turnIndex);
      turns.push(currentTurn);
    }
    const turn = currentTurn ?? ensurePrelude();
    addEntryToTurn(turn, entry);

    // toolResult 不单独成行：它的内容挂在对应工具行下面
    if (entry.kind === "message" && entry.role === "toolResult") continue;

    const node = tree.byId.get(entry.entry_id);
    const row = entryRow(entry, node, branch);
    if (entry.kind === "message" && entry.role === "assistant") {
      const tools = toolsByEntry.get(entry.entry_id) ?? [];
      row.toolNames = tools.map((tool) => tool.tool_name);
      addRow(turn, row);
      for (const tool of tools) addRow(turn, toolRow(tool, tree, branch));
    } else {
      addRow(turn, row);
    }
  }

  // 回填 Turn / 实时 Turn 的元数据按助手条目挂回用户 Turn
  const entryToTurn = new Map<string, StreamTurn>();
  for (const turn of [...turns, ...(prelude === null ? [] : [prelude])]) {
    for (const entryId of turn.entryIds) entryToTurn.set(entryId, turn);
  }

  const turnKeyToTurn = new Map<string, StreamTurn>();
  for (const row of data.turns) {
    const key = `${row.run_seq}:${row.turn_index}`;
    const node = tree.byId.get(row.message_entry_id);
    const turn =
      entryToTurn.get(row.message_entry_id) ??
      turnByTime(row.started_at) ??
      turns[turns.length - 1] ??
      ensurePrelude();
    turnKeyToTurn.set(key, turn);
    if (!turn.turnKeys.includes(key)) turn.turnKeys.push(key);

    // 旁支上的助手消息不算进当前 Turn 的用量；当前分支以 tree 的判断为准
    if (node !== undefined && !node.onCurrentBranch) continue;
    turn.stats.tokensIn += row.tokens_in ?? 0;
    turn.stats.tokensOut += row.tokens_out ?? 0;
    turn.stats.cacheRead += row.cache_read ?? 0;
    turn.stats.cacheWrite += row.cache_write ?? 0;
    turn.stats.cost += row.cost ?? 0;
    if (row.stop_reason !== null) turn.stopReason = row.stop_reason;
  }

  const toolRowByCallId = new Map<string, StreamRow>();
  for (const turn of [...turns, ...(prelude === null ? [] : [prelude])]) {
    for (const row of turn.rows) {
      if (row.kind === "tool" && row.toolCallId !== null) toolRowByCallId.set(row.toolCallId, row);
    }
  }
  for (const tool of unlinkedTools) {
    const turn =
      turnByKey(tool.run_seq, tool.turn_index) ??
      turnByTime(tool.started_at ?? tool.ended_at) ??
      turns[turns.length - 1] ??
      ensurePrelude();
    const row = toolRow(tool, tree, branch);
    row.onCurrentBranch = turn.onCurrentBranch;
    addRow(turn, row);
    if (row.toolCallId !== null) toolRowByCallId.set(row.toolCallId, row);
  }

  // 事件可能按 id 倒序取回（时间线只要最近的 2000 条）；处理时一律按时间正序，
  // 这样开始类事件的归属与行排序不会被取数顺序影响。
  const events = [...data.events].sort(
    (a, b) => (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "") || a.id - b.id,
  );

  // 请求：一次请求一行，响应状态与关联钩子事件放在行详情里
  const requestRowBySeq = new Map<number, StreamRow>();
  for (const request of data.requests) {
    const turn =
      turnByKey(request.run_seq, request.turn_index) ??
      turnByTime(request.created_at) ??
      turns[turns.length - 1] ??
      ensurePrelude();
    const row = requestRow(request);
    row.onCurrentBranch = turn.onCurrentBranch;
    addRow(turn, row);
    requestRowBySeq.set(request.request_seq, row);
  }

  // 事件：先挂到 Turn，再看是否需要单独成行
  const responseRowBySeq = new Map<number, StreamRow>();
  for (const event of events) {
    const turn =
      turnForEvent(event) ??
      turns[turns.length - 1] ??
      ensurePrelude();
    if (!turn.eventIds.includes(event.event_id)) turn.eventIds.push(event.event_id);
    turn.startedAt = minTime(turn.startedAt, event.occurred_at);
    turn.endedAt = maxTime(turn.endedAt, event.occurred_at);

    if (event.event_type === "tool_execution_start" || event.event_type === "tool_execution_end") {
      const callId = strOf(asObject(event.payload)?.toolCallId);
      const row = callId === null ? undefined : toolRowByCallId.get(callId);
      if (row !== undefined) {
        row.relatedEventIds.push(event.event_id);
        continue;
      }
      // 工具行缺失（例如库被截断）：让事件自己成行，至少不丢操作痕迹
      const fallback = eventRow(event);
      fallback.category = "tool";
      fallback.label = strOf(asObject(event.payload)?.toolName) ?? "工具";
      fallback.onCurrentBranch = turn.onCurrentBranch;
      addRow(turn, fallback);
      continue;
    }

    if (event.event_type === "provider_request" || event.event_type === "provider_response") {
      const seq = numOf(asObject(event.payload)?.requestSeq);
      const requestLine = seq === null ? undefined : requestRowBySeq.get(seq);
      if (requestLine !== undefined && seq !== null) {
        requestLine.relatedEventIds.push(event.event_id);
        if (event.event_type === "provider_response") {
          const existing = responseRowBySeq.get(seq);
          if (existing !== undefined) {
            existing.relatedEventIds.push(event.event_id);
          } else {
            const row = responseRow(event, requestLine, seq);
            row.onCurrentBranch = turn.onCurrentBranch;
            addRow(turn, row);
            responseRowBySeq.set(seq, row);
          }
        }
        continue;
      }
      // 请求行缺失：保留成一行 provider 事件
      const fallback = eventRow(event);
      fallback.category = "model";
      fallback.onCurrentBranch = turn.onCurrentBranch;
      addRow(turn, fallback);
      continue;
    }

    if (HIDDEN_EVENT_TYPES.has(event.event_type)) continue;

    const row = eventRow(event);
    row.onCurrentBranch = turn.onCurrentBranch;
    addRow(turn, row);
  }

  for (const turn of [...turns, ...(prelude === null ? [] : [prelude])]) {
    turn.rows.sort(compareRows);
    turn.stats.toolCount = turn.rows.filter(
      (row) => row.kind === "tool" && row.onCurrentBranch && row.toolCallId !== null,
    ).length;
    turn.stats.toolErrors = turn.rows.filter(
      (row) => row.kind === "tool" && row.onCurrentBranch && row.toolError,
    ).length;
    turn.failed =
      turn.stats.toolErrors > 0 || turn.stopReason === "error";
  }

  // 进行中：会话 state=active 时，最后一个 Turn 末尾放一条等待占位
  const lastTurn = turns[turns.length - 1] ?? prelude;
  const running = data.session.state === "active" && lastTurn !== null;
  if (lastTurn !== null && running) {
    lastTurn.running = true;
    lastTurn.rows.push({
      ...blankRow({
        key: `pending:${lastTurn.key}`,
        kind: "pending",
        category: "msg",
        label: "生成中",
        text: "等待助手写入会话文件…",
        fromFile: false,
      }),
      onCurrentBranch: lastTurn.onCurrentBranch,
    });
  }

  return {
    prelude,
    turns,
    branch: {
      entries: tree.total,
      current: tree.currentBranch.size,
      offCurrent: tree.total - tree.currentBranch.size,
      forks: tree.forkPoints,
      orphans: tree.orphans,
    },
    running,
  };

  // ── 内部函数（闭包用到 tree / branch / turns / prelude） ─────────────────

  function newTurn(entry: TimelineMessageRow | null, index: number | null): StreamTurn {
    return {
      key: entry === null ? "prelude" : `turn:${entry.entry_id}`,
      kind: entry === null ? "prelude" : "turn",
      index,
      summary: entry === null ? "会话开始" : truncate(entry.text?.trim() || "（无正文）", 120),
      startedAt: entry?.timestamp ?? null,
      endedAt: entry?.timestamp ?? null,
      running: false,
      failed: false,
      stopReason: null,
      rows: [],
      stats: {
        toolCount: 0,
        toolErrors: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
      entryIds: [],
      turnKeys: [],
      eventIds: [],
      onCurrentBranch: entry === null ? true : branch.has(entry.entry_id),
    };
  }

  function turnByKey(runSeq: number | null, turnIndexValue: number | null): StreamTurn | null {
    if (runSeq === null || turnIndexValue === null) return null;
    return turnKeyToTurn.get(`${runSeq}:${turnIndexValue}`) ?? null;
  }

  function turnByTime(at: string | null): StreamTurn | null {
    if (at === null) return null;
    if (turns.length === 0) return prelude ?? ensurePrelude();
    const firstStart = turns[0]?.startedAt ?? null;
    if (firstStart !== null && at < firstStart) return ensurePrelude();

    let candidate: StreamTurn | null = null;
    for (const turn of turns) {
      if (turn.startedAt !== null && turn.startedAt <= at) candidate = turn;
      else if (turn.startedAt !== null) break;
    }
    return candidate ?? turns[0] ?? prelude;
  }

  function turnForEvent(event: EventRow): StreamTurn | null {
    const byKey = turnByKey(event.run_seq, event.turn_index);
    if (byKey !== null) return byKey;

    const at = event.occurred_at;
    if (at !== null) {
      // 运行 / 会话开始发生在用户消息之前几毫秒：挂到下一条用户 Turn，别塞进上一轮末尾。
      // 首次会话的 session_start / probe_health 属于 prelude，不能挂到第一条用户消息上。
      if (event.event_type === "agent_start") {
        return turnForStart(at);
      }
      if (event.event_type === "session_start" || event.event_type === "probe_health") {
        const firstStart = turns[0]?.startedAt ?? null;
        if (firstStart !== null && at < firstStart) return ensurePrelude();
        return turnForStart(at);
      }
    }

    const byTime = turnByTime(at);
    if (byTime !== null) return byTime;
    return turns[turns.length - 1] ?? prelude;
  }

  /** 开始类事件：落在某个 Turn 的时间范围内就用它，落在两轮之间就用下一轮 */
  function turnForStart(at: string): StreamTurn | null {
    for (const turn of turns) {
      if (
        turn.startedAt !== null &&
        turn.startedAt <= at &&
        (turn.endedAt === null || at <= turn.endedAt)
      ) {
        return turn;
      }
    }
    for (const turn of turns) {
      if (turn.startedAt !== null && turn.startedAt > at) return turn;
    }
    return turns[turns.length - 1] ?? prelude;
  }
}

/** 最近 `loadedPages` 页 Turn（默认每页 20 个）；正序返回，界面反转显示 */
export function turnWindow(stream: SessionStream, loadedPages = 1, pageSize = 20): TurnWindow {
  const size = Math.max(1, Math.floor(pageSize));
  const loaded = Math.max(1, Math.floor(loadedPages));
  const total = stream.turns.length;
  const start = Math.max(0, total - loaded * size);
  const hasEarlier = start > 0;
  return {
    turns: stream.turns.slice(start),
    prelude: hasEarlier ? null : stream.prelude,
    hasEarlier,
    total,
    pageSize: size,
    loaded,
  };
}

function entryRow(
  entry: TimelineMessageRow,
  node: TreeNode | undefined,
  branch: Set<string>,
): StreamRow {
  const presentation = entryPresentation(entry);
  return blankRow({
    key: `entry:${entry.entry_id}`,
    ...presentation,
    at: entry.timestamp,
    text: entry.text,
    thinking: entry.thinking,
    fromFile: true,
    entryId: entry.entry_id,
    parentId: entry.parent_id,
    childIds: node?.children.map((child) => child.entry_id) ?? [],
    entryIndex: entry.entry_index,
    payloadBytes: entry.payload_bytes,
    onCurrentBranch: branch.has(entry.entry_id),
    forkPoint: node?.forkPoint ?? false,
    branchStart: node?.branchStart ?? false,
    orphan: node?.orphan ?? entry.parent_id !== null,
  });
}

function entryPresentation(entry: TimelineMessageRow): Pick<StreamRow, "kind" | "category" | "label"> {
  if (entry.kind === "message") {
    if (entry.role === "user") return { kind: "user", category: "msg", label: "用户" };
    if (entry.role === "assistant") return { kind: "assistant", category: "msg", label: "助手" };
    if (entry.role === "system") return { kind: "system", category: "session", label: "系统" };
    return { kind: "system", category: "session", label: entry.role ?? "消息" };
  }

  switch (entry.kind) {
    case "model_change":
      return { kind: "system", category: "model", label: "模型" };
    case "thinking_level_change":
      return { kind: "system", category: "model", label: "思考" };
    case "compaction":
      return { kind: "system", category: "session", label: "压缩" };
    case "branch_summary":
      return { kind: "system", category: "session", label: "分支" };
    case "context_edit":
      return { kind: "system", category: "session", label: "上下文" };
    case "label":
      return { kind: "system", category: "session", label: "标签" };
    case "session_info":
      return { kind: "system", category: "session", label: "会话" };
    case "usage":
      return { kind: "system", category: "session", label: "用量" };
    case "custom":
    case "custom_message":
      return { kind: "system", category: "session", label: "自定义" };
    default:
      return { kind: "system", category: "session", label: entry.kind };
  }
}

function toolRow(
  tool: ToolCallIndexRow,
  tree: MessageTree,
  branch: Set<string>,
): StreamRow {
  const node = tool.entry_id === null ? undefined : tree.byId.get(tool.entry_id);
  return blankRow({
    key: `tool:${tool.tool_call_id}`,
    kind: "tool",
    category: "tool",
    at: tool.started_at ?? tool.ended_at,
    label: tool.tool_name,
    text: summarizeArgs(tool.args_preview),
    fromFile: tool.entry_id !== null,
    entryId: tool.entry_id,
    resultEntryId: tool.result_entry_id,
    parentId: tool.entry_id,
    entryIndex: node?.entry_index ?? null,
    toolCallId: tool.tool_call_id,
    toolName: tool.tool_name,
    argsPreview: tool.args_preview,
    argsBytes: tool.args_bytes,
    resultPreview: tool.result_preview,
    resultBytes: tool.result_bytes,
    toolError: tool.is_error === 1,
    durationMs: tool.duration_ms,
    onCurrentBranch: tool.entry_id === null ? true : branch.has(tool.entry_id),
    forkPoint: node?.forkPoint ?? false,
    branchStart: node?.branchStart ?? false,
    orphan: node?.orphan ?? false,
  });
}

function requestRow(request: RequestIndexRow): StreamRow {
  const parts = [request.provider, request.api, request.model].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return blankRow({
    key: `request:${request.request_seq}`,
    kind: "request",
    category: "model",
    at: request.created_at,
    label: "provider →",
    text: parts.length === 0 ? `请求 #${request.request_seq}` : parts.join(" · "),
    fromFile: false,
    requestSeq: request.request_seq,
    payloadBytes: request.payload_bytes,
    status: request.status,
  });
}

/** provider 响应单独一行：原型里请求、响应是两条时间线记录 */
function responseRow(event: EventRow, requestLine: StreamRow, requestSeq: number): StreamRow {
  const payload = asObject(event.payload);
  const status = numOf(payload?.status) ?? requestLine.status;
  const started = requestLine.at === null ? Number.NaN : Date.parse(requestLine.at);
  const ended = event.occurred_at === null ? Number.NaN : Date.parse(event.occurred_at);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
  return blankRow({
    key: `response:${requestSeq}`,
    kind: "response",
    category: "model",
    at: event.occurred_at,
    label: "provider ←",
    text: status === null ? "响应已到达" : formatHttpStatus(status),
    fromFile: false,
    requestSeq,
    status,
    durationMs,
    relatedEventIds: [event.event_id],
  });
}

function formatHttpStatus(status: number): string {
  const text: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  const label = text[status];
  return label === undefined ? `HTTP ${status}` : `${status} ${label}`;
}

function eventRow(event: EventRow): StreamRow {
  return blankRow({
    key: `event:${event.event_id}`,
    kind: "event",
    category: eventCategory(event.event_type),
    at: event.occurred_at,
    label: eventLabel(event.event_type),
    text: eventText(event),
    fromFile: false,
    eventId: event.event_id,
    eventType: event.event_type,
  });
}

function eventCategory(eventType: string): StreamCategory {
  if (eventType.startsWith("agent_")) return "run";
  if (eventType.startsWith("probe_")) return "probe";
  if (
    eventType.startsWith("provider_") ||
    eventType === "model_select" ||
    eventType === "thinking_level_select"
  ) {
    return "model";
  }
  return "session";
}

function eventLabel(eventType: string): string {
  switch (eventType) {
    case "session_start":
      return "启动";
    case "session_shutdown":
      return "关闭";
    case "session_info_changed":
      return "名称";
    case "session_compact":
      return "压缩";
    case "session_compact_failed":
      return "压缩失败";
    case "session_tree":
      return "分支";
    case "agent_start":
      return "运行";
    case "agent_settled":
      return "settled";
    case "provider_request":
      return "provider →";
    case "provider_response":
    case "provider_response_unmatched":
      return "provider ←";
    case "model_select":
      return "模型";
    case "thinking_level_select":
      return "思考";
    case "probe_health":
      return "探针";
    default:
      return eventType;
  }
}

function eventText(event: EventRow): string | null {
  const payload = asObject(event.payload);
  switch (event.event_type) {
    case "session_start": {
      const reason = strOf(payload?.reason);
      return reason === null ? "会话开始" : `会话开始 · ${reason}`;
    }
    case "session_shutdown": {
      const reason = strOf(payload?.reason);
      return reason === null ? "会话关闭" : `会话关闭 · ${reason}`;
    }
    case "session_info_changed":
      return `名称 → ${strOf(payload?.name) ?? "（空）"}`;
    case "session_compact": {
      const reason = strOf(payload?.reason);
      return reason === null ? "上下文压缩" : `上下文压缩 · ${reason}`;
    }
    case "session_compact_failed": {
      const message = strOf(payload?.errorMessage);
      return message === null ? "上下文压缩失败" : `上下文压缩失败 · ${message}`;
    }
    case "session_tree":
      return `切换分支 · ${strOf(payload?.oldLeafId) ?? "?"} → ${strOf(payload?.newLeafId) ?? "?"}`;
    case "agent_start":
      return `运行 #${numOf(payload?.runSeq) ?? "?"} 开始`;
    case "agent_settled":
      return `运行 #${numOf(payload?.runSeq) ?? "?"} ${payload?.aborted === true ? "中止" : "结束"}`;
    case "agent_end":
      return `运行 #${numOf(payload?.runSeq) ?? "?"} 收到 ${numOf(payload?.messageCount) ?? 0} 条消息`;
    case "provider_request":
      return `请求 #${numOf(payload?.requestSeq) ?? "?"} · ${numOf(payload?.payloadBytes) ?? 0} 字节`;
    case "provider_response":
      return `响应 #${numOf(payload?.requestSeq) ?? "?"} · ${numOf(payload?.status) ?? "?"}`;
    case "provider_response_unmatched":
      return `未配对的响应 · ${numOf(payload?.status) ?? "?"}`;
    case "model_select": {
      const model = strOf(payload?.model) ?? "?";
      const previous = strOf(payload?.previousModel);
      return previous === null ? `模型 → ${model}` : `模型 → ${model}（原 ${previous}）`;
    }
    case "thinking_level_select":
      return `思考等级 → ${strOf(payload?.level) ?? "?"}`;
    case "probe_health":
      return payload?.healthy === false ? "探针不可达" : "探针连通";
    default:
      return jsonSummary(event.payload);
  }
}

function summarizeArgs(preview: string | null): string | null {
  if (preview === null || preview.trim() === "") return null;
  const parsed = safeParse(preview);
  if (isObject(parsed)) {
    for (const key of ["command", "cmd", "path", "file_path", "pattern", "query", "url", "description"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim() !== "") return truncate(value, 160);
    }
  }
  // args_preview 只有前 500 个字符，长参数常常是截断的 JSON，解析不了；
  // 用正则从开头抠出最常见的几个字段，至少让行摘要能读。
  const match = preview.match(
    /"(command|cmd|path|file_path|pattern|query|url)"\s*:\s*"((?:\\.|[^"\\])*)"/,
  );
  if (match !== null && match[2] !== undefined) {
    let raw = match[2];
    try {
      const parsedValue = JSON.parse(`"${match[2]}"`) as unknown;
      if (typeof parsedValue === "string") raw = parsedValue;
    } catch {
      raw = raw.replace(/\\(["\\/bfnrt])/g, "$1");
    }
    if (raw.trim() !== "") return truncate(raw, 160);
  }
  return truncate(preview.replace(/\s+/g, " ").trim(), 160);
}

function jsonSummary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(value, 200);
  try {
    return truncate(JSON.stringify(value), 200);
  } catch {
    return null;
  }
}

function compareRows(a: StreamRow, b: StreamRow): number {
  if (a.at !== null && b.at !== null && a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.at === null && b.at !== null) return 1;
  if (a.at !== null && b.at === null) return -1;
  const rank = rowRank(a) - rowRank(b);
  if (rank !== 0) return rank;
  // 同一时间的行保持构造顺序：sort 在 Node 上是稳定的
  return 0;
}

function rowRank(row: StreamRow): number {
  switch (row.kind) {
    case "user":
      return 0;
    case "request":
      return 1;
    case "response":
      return 1;
    case "assistant":
      return 2;
    case "tool":
      return 3;
    case "event":
      return 4;
    case "system":
      return 5;
    case "pending":
      return 9;
  }
}

function blankRow(
  init: Pick<StreamRow, "key" | "kind" | "category" | "label"> & Partial<StreamRow>,
): StreamRow {
  return {
    at: null,
    text: null,
    thinking: null,
    fromFile: false,
    entryId: null,
    resultEntryId: null,
    parentId: null,
    childIds: [],
    entryIndex: null,
    payloadBytes: 0,
    onCurrentBranch: true,
    forkPoint: false,
    branchStart: false,
    orphan: false,
    toolCallId: null,
    toolName: null,
    toolNames: [],
    argsPreview: null,
    argsBytes: 0,
    resultPreview: null,
    resultBytes: null,
    toolError: false,
    durationMs: null,
    requestSeq: null,
    eventId: null,
    eventType: null,
    status: null,
    relatedEventIds: [],
    ...init,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return asObject(value) !== null;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function minTime(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

function maxTime(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}
