/**
 * 顶部分组筛选的纯逻辑（R3）。
 *
 * 单独成文件有两个原因：
 *   - 组件里只管渲染与交互，规则的读写在这里，可以直接跑 `node --test`；
 *   - 存进 `localStorage` 的结构是版本化的：以后加分类，老的存档不该整个作废。
 *
 * 存档结构：`{ cats: { msg, session, run, tool, model, probe }, think, branch }`。
 */
import type { StreamCategory } from "./stream.ts";

export type TimelineFilters = Record<StreamCategory, boolean> & {
  /** 是否展开思考内容 */
  think: boolean;
  /** 是否显示不在当前分支上的条目 */
  branch: boolean;
};

export const FILTER_KEY = "pi-observer-filters";

export const CATEGORY_LABELS: ReadonlyArray<readonly [StreamCategory, string]> = [
  ["msg", "消息"],
  ["session", "会话"],
  ["run", "运行"],
  ["tool", "工具"],
  ["model", "模型"],
  ["probe", "探针"],
];

export const DEFAULT_FILTERS: TimelineFilters = {
  msg: true,
  session: true,
  run: true,
  tool: true,
  model: true,
  probe: true,
  think: true,
  branch: false,
};

/**
 * 解析存档。
 *
 * 读不出来、字段缺失、不是布尔值时一律退回默认：筛选只是显示偏好，
 * 存坏了不该让页面开天窗。
 */
export function parseFilters(raw: string | null): TimelineFilters {
  if (raw === null) return { ...DEFAULT_FILTERS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_FILTERS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_FILTERS };
  }
  const record = parsed as { cats?: unknown; think?: unknown; branch?: unknown };
  const cats = (typeof record.cats === "object" && record.cats !== null ? record.cats : {}) as Record<
    string,
    unknown
  >;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
  return {
    msg: bool(cats.msg, true),
    session: bool(cats.session, true),
    run: bool(cats.run, true),
    tool: bool(cats.tool, true),
    model: bool(cats.model, true),
    probe: bool(cats.probe, true),
    think: bool(record.think, true),
    branch: bool(record.branch, false),
  };
}

/** 存成存档；写失败（隐私模式）由调用方忽略 */
export function stringifyFilters(filters: TimelineFilters): string {
  const { msg, session, run, tool, model, probe, think, branch } = filters;
  return JSON.stringify({ cats: { msg, session, run, tool, model, probe }, think, branch });
}
