import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_META,
  activityKey,
  countByState,
  displayState,
  filterSessions,
  groupByProject,
  localDayStartIso,
} from "../src/lib/session-view.ts";
import type { SessionListItem } from "../src/lib/types.ts";

function session(partial: Partial<SessionListItem> & { session_id: string }): SessionListItem {
  return {
    cwd: "/work/a",
    file_path: null,
    parent_session: null,
    name: null,
    started_at: "2026-10-19T08:00:00.000Z",
    last_activity_at: "2026-10-19T08:00:00.000Z",
    message_count: 0,
    turn_count: 0,
    tool_call_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost: 0,
    state: "idle",
    source: "live",
    last_reconciled_at: null,
    first_user_text: null,
    ...partial,
  };
}

test("显示状态：回填会话标「未对账」，不冒充空闲", () => {
  // 回填写进去的 state 是默认值（文件里看不到进程/agent 状态），所以一律不算真状态
  assert.equal(displayState(session({ session_id: "a", source: "backfill", state: "idle" })), "unreconciled");
  assert.equal(displayState(session({ session_id: "a", source: "backfill", state: "active" })), "unreconciled");

  assert.equal(displayState(session({ session_id: "b", source: "live", state: "active" })), "active");
  assert.equal(displayState(session({ session_id: "c", source: "merged", state: "idle" })), "idle");
  assert.equal(displayState(session({ session_id: "d", source: "merged", state: "ended" })), "ended");

  // 库里出现没见过的值：按「已结束」保守显示，不猜成进行中
  assert.equal(displayState(session({ session_id: "e", source: "live", state: "weird" })), "ended");

  assert.equal(STATE_META.unreconciled.label, "未对账");
  assert.equal(STATE_META.active.label, "进行中");
});

test("按状态计数", () => {
  const counts = countByState([
    session({ session_id: "a", source: "live", state: "active" }),
    session({ session_id: "b", source: "merged", state: "idle" }),
    session({ session_id: "c", source: "backfill", state: "idle" }),
    session({ session_id: "d", source: "backfill", state: "idle" }),
    session({ session_id: "e", source: "live", state: "ended" }),
  ]);
  assert.deepEqual(counts, { active: 1, idle: 1, ended: 1, unreconciled: 2 });
});

test("分组：组内与组间都按最后活跃时间倒序", () => {
  const items = [
    session({ session_id: "old-a", cwd: "/p1", last_activity_at: "2026-10-17T10:00:00.000Z" }),
    session({ session_id: "new-a", cwd: "/p1", last_activity_at: "2026-10-19T10:00:00.000Z" }),
    session({ session_id: "mid-b", cwd: "/p2", last_activity_at: "2026-10-18T10:00:00.000Z" }),
  ];
  const groups = groupByProject(items);

  assert.deepEqual(
    groups.map((g) => g.cwd),
    ["/p1", "/p2"],
    "组按组内最近活动倒序",
  );
  assert.deepEqual(groups[0]?.sessions.map((s) => s.session_id), ["new-a", "old-a"]);
  assert.equal(groups[0]?.lastActivity, "2026-10-19T10:00:00.000Z");
  assert.equal(groups[1]?.sessions.length, 1);
});

test("分组：没有 cwd 归到「未知工作目录」；没有活跃时间按开始时间排、都没有排最后", () => {
  const groups = groupByProject([
    session({ session_id: "no-time", cwd: "/p", last_activity_at: null, started_at: null }),
    session({ session_id: "started", cwd: "/p", last_activity_at: null, started_at: "2026-10-19T09:00:00.000Z" }),
    session({ session_id: "unknown", cwd: "", last_activity_at: "2026-10-16T09:00:00.000Z" }),
  ]);

  assert.deepEqual(
    groups.map((g) => g.cwd),
    ["/p", "（未知工作目录）"],
  );
  assert.deepEqual(
    groups[0]?.sessions.map((s) => s.session_id),
    ["started", "no-time"],
    "没有活跃时间时退到开始时间；两者都没有排最后",
  );
  assert.equal(activityKey(session({ session_id: "x", last_activity_at: null, started_at: null })), "");
  assert.deepEqual(groupByProject([]), []);
});

test("筛选：搜索匹配会话 id / 项目路径 / 名称 / 首条用户消息，忽略大小写与首尾空白", () => {
  const items = [
    session({ session_id: "01a149bf-x", cwd: "/Users/me/Notes", first_user_text: "排查语法高亮" }),
    session({ session_id: "deadbeef", cwd: "/tmp/other", name: "整理 PRD", first_user_text: "改文案" }),
  ];

  assert.equal(filterSessions(items, { query: "  NOTES " }).length, 1);
  assert.equal(filterSessions(items, { query: "01A149" }).length, 1);
  assert.equal(filterSessions(items, { query: "语法" }).length, 1);
  assert.equal(filterSessions(items, { query: "prd" }).length, 1, "名称也参与搜索");
  assert.equal(filterSessions(items, { query: "没有这个" }).length, 0);
  assert.equal(filterSessions(items, {}).length, 2, "空条件不过滤");
});

test("筛选：状态按显示状态算，回填会话不会被「空闲」筛出来", () => {
  const items = [
    session({ session_id: "live-idle", source: "merged", state: "idle" }),
    session({ session_id: "backfill-idle", source: "backfill", state: "idle" }),
  ];

  assert.deepEqual(
    filterSessions(items, { state: "idle" }).map((s) => s.session_id),
    ["live-idle"],
  );
  assert.deepEqual(
    filterSessions(items, { state: "unreconciled" }).map((s) => s.session_id),
    ["backfill-idle"],
  );
  assert.deepEqual(
    filterSessions(items, { source: "backfill" }).map((s) => s.session_id),
    ["backfill-idle"],
  );
  assert.equal(filterSessions(items, { state: "all", source: "all" }).length, 2);
});

test("今天的 0 点按本地时区算", () => {
  const now = new Date(2026, 9, 19, 15, 30, 12, 345);
  const since = localDayStartIso(now);
  const expected = new Date(2026, 9, 19, 0, 0, 0, 0).toISOString();

  assert.equal(since, expected);
  assert.ok(Date.parse(since) <= now.getTime());
  assert.ok(now.getTime() - Date.parse(since) < 24 * 3600_000);
  assert.match(since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
