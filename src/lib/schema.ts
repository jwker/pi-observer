/**
 * 看板自有库的表结构与索引（PRD §8.2 / §8.5）。
 *
 * 为什么是 `.ts` 而不是 `.sql`：Next 构建后代码不保证还能按相对路径读到仓库里的 `.sql`
 * 文件（`import.meta.url` 指向 `.next/server/...`）。内联成常量字符串就没有这个问题。
 *
 * 全部语句幂等（IF NOT EXISTS），schema 变更靠 `SCHEMA_VERSION` + `PRAGMA user_version`。
 *
 * 迁移策略：**只做增量**（新增表 / 索引 / 可空列）。因为 CREATE TABLE IF NOT EXISTS
 * 对已存在的表是空操作，所以「加一张表」这种变更天然幂等；可空列用 ALTER TABLE 补，
 * 旧行保持 NULL。要改列类型或加非空约束则必须先想清楚旧数据怎么办。
 */

export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  cwd               TEXT NOT NULL DEFAULT '',
  file_path         TEXT UNIQUE,
  parent_session    TEXT,
  version           INTEGER,
  name              TEXT,
  started_at        TEXT,
  last_activity_at  TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  cache_write       INTEGER NOT NULL DEFAULT 0,
  cost              REAL    NOT NULL DEFAULT 0,
  state             TEXT    NOT NULL DEFAULT 'active',
  source            TEXT    NOT NULL DEFAULT 'live',
  last_reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  run_seq     INTEGER NOT NULL,
  started_at  TEXT,
  ended_at    TEXT,
  outcome     TEXT,
  UNIQUE (session_id, run_seq)
);

CREATE TABLE IF NOT EXISTS turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  run_seq           INTEGER NOT NULL,
  turn_index        INTEGER NOT NULL,
  message_entry_id  TEXT NOT NULL UNIQUE,
  started_at        TEXT,
  ended_at          TEXT,
  stop_reason       TEXT,
  thinking_level    TEXT,
  assistant_message TEXT,
  tool_results      TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  cost              REAL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id         TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  parent_tool_call_id  TEXT,
  tool_name            TEXT NOT NULL DEFAULT '',
  args                 TEXT,
  result               TEXT,
  partial_result       TEXT,
  is_error             INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER,
  started_at           TEXT,
  ended_at             TEXT,
  run_seq              INTEGER,
  turn_index           INTEGER
);

CREATE TABLE IF NOT EXISTS llm_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  request_seq        INTEGER NOT NULL,
  provider           TEXT,
  api                TEXT,
  model              TEXT,
  payload            TEXT,
  payload_bytes      INTEGER NOT NULL DEFAULT 0,
  payload_truncated  INTEGER NOT NULL DEFAULT 0,
  status             INTEGER,
  response_headers   TEXT,
  correlation        TEXT NOT NULL DEFAULT 'serial_assumed',
  created_at         TEXT NOT NULL,
  run_seq            INTEGER,
  turn_index         INTEGER,
  UNIQUE (session_id, request_seq)
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  session_id   TEXT NOT NULL,
  layer        TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  run_seq      INTEGER,
  turn_index   INTEGER,
  payload      TEXT,
  occurred_at  TEXT,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_status (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen_at   TEXT,
  dropped_count  INTEGER NOT NULL DEFAULT 0,
  queue_depth    INTEGER NOT NULL DEFAULT 0,
  probe_version  TEXT
);

-- 会话文件里的逐条条目（PRD §8.2 / §9.1）。消息树从 parent_id 渲染。
-- kind 取 JSONL 条目的 type：message / model_change / thinking_level_change / usage /
-- compaction / context_edit / branch_summary / custom / custom_message / label / session_info。
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  parent_id    TEXT,
  kind         TEXT NOT NULL,
  role         TEXT,
  timestamp    TEXT,
  entry_index  INTEGER NOT NULL DEFAULT 0,
  text         TEXT,
  payload      TEXT,
  UNIQUE (session_id, entry_id)
);

-- 会话文件的读取进度（PRD §9.1）。没有这张表，每次启动都要把所有文件重读一遍。
CREATE TABLE IF NOT EXISTS jsonl_files (
  path          TEXT PRIMARY KEY,
  session_id    TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  mtime_ms      INTEGER NOT NULL DEFAULT 0,
  entry_count   INTEGER NOT NULL DEFAULT 0,
  last_read_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_groups       ON events(session_id, run_seq, turn_index, id);
CREATE INDEX IF NOT EXISTS idx_events_type         ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_received     ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_turns_session       ON turns(session_id, run_seq, turn_index);
CREATE INDEX IF NOT EXISTS idx_tools_session       ON tool_calls(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_requests_session    ON llm_requests(session_id, request_seq);
CREATE INDEX IF NOT EXISTS idx_requests_created    ON llm_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_activity   ON sessions(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session    ON messages(session_id, entry_index);
CREATE INDEX IF NOT EXISTS idx_messages_tree       ON messages(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_kind       ON messages(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_jsonl_files_session ON jsonl_files(session_id);
`;
