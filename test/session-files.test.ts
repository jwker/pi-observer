/**
 * 会话文件的发现与元信息。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessionPaths, listSessionMeta, readSessionMeta } from "../src/main/lib/session-files.ts";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

function makeSession(root: string, dir: string, id: string, body: string): string {
  const projectDir = join(root, dir);
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `2026-11-02T11-40-26-856Z_${id}.jsonl`);
  writeFileSync(path, body, "utf8");
  return path;
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-files-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("读会话头：id、cwd、版本与第一条用户消息", () => {
  withRoot((root) => {
    const path = makeSession(
      root,
      "--tmp-demo--",
      "sess-1",
      line({ type: "session", version: 3, id: "sess-1", timestamp: "2026-11-02T11:40:26.856Z", cwd: "/tmp/demo" }) +
        line({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-11-02T11:40:30.000Z",
          message: { role: "user", content: [{ type: "text", text: "读一下 README" }] },
        }),
    );
    const meta = readSessionMeta(path);
    assert.ok(meta);
    assert.equal(meta.session_id, "sess-1");
    assert.equal(meta.cwd, "/tmp/demo");
    assert.equal(meta.version, 3);
    assert.equal(meta.started_at, "2026-11-02T11:40:26.856Z");
    assert.equal(meta.first_user_text, "读一下 README");
  });
});

test("列出全部会话文件，按修改时间倒序", () => {
  withRoot((root) => {
    makeSession(root, "--a--", "sess-a", line({ type: "session", version: 3, id: "sess-a", cwd: "/a" }));
    makeSession(root, "--b--", "sess-b", line({ type: "session", version: 3, id: "sess-b", cwd: "/b" }));
    const paths = listSessionPaths(root);
    assert.equal(paths.length, 2);
    const metas = listSessionMeta(10, root);
    assert.equal(metas.length, 2);
    assert.deepEqual(
      metas.map((meta) => meta.session_id).sort(),
      ["sess-a", "sess-b"],
    );
  });
});

test("读不出来的文件跳过，不影响其它会话", () => {
  withRoot((root) => {
    const good = makeSession(root, "--a--", "sess-a", line({ type: "session", version: 3, id: "sess-a", cwd: "/a" }));
    const bad = join(root, "--b--", "2026-11-02T11-40-26-856Z_sess-b.jsonl");
    mkdirSync(join(root, "--b--"), { recursive: true });
    writeFileSync(bad, "这不是 JSONL\n", "utf8");
    assert.equal(readSessionMeta(bad)?.session_id, "sess-b");
    const metas = listSessionMeta(10, root);
    assert.equal(metas.length, 2);
    assert.ok(metas.some((meta) => meta.file_path === good));
  });
});
