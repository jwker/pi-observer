/**
 * 探针：只有一个钩子，把请求体写成文件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import probe from "../ext/index.ts";

interface Handler {
  (event: unknown, ctx: unknown): void;
}

function fakePi(): { handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler): void {
      handlers.set(name, handler);
    },
  };
  probe(pi as never);
  return { handlers };
}

const ctx = {
  sessionManager: {
    getSessionId: () => "sess-1",
  },
};

test("只注册 before_provider_request 一个钩子", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-probe-"));
  process.env.PI_REQUEST_STORE_DIR = root;
  try {
    const { handlers } = fakePi();
    assert.deepEqual([...handlers.keys()], ["before_provider_request"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("请求体写成文件，文件名带序号", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-probe-"));
  process.env.PI_REQUEST_STORE_DIR = root;
  try {
    const { handlers } = fakePi();
    const handler = handlers.get("before_provider_request");
    assert.ok(handler);

    handler({ payload: { model: "x", messages: [{ role: "user", content: "hi" }] } }, ctx);
    handler({ payload: { model: "y", messages: [] } }, ctx);

    const dir = join(root, "sess-1");
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2);
    assert.match(files[0] ?? "", /^req-000001-\d{8}T\d{9}Z\.json$/);
    assert.match(files[1] ?? "", /^req-000002-\d{8}T\d{9}Z\.json$/);

    const body = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as { model: string };
    assert.equal(body.model, "x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写文件失败不影响 Pi：handler 不抛异常", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-probe-"));
  // 指向一个不存在的父目录，mkdir 会失败
  process.env.PI_REQUEST_STORE_DIR = join(root, "不存在的", "更深");
  try {
    const { handlers } = fakePi();
    const handler = handlers.get("before_provider_request");
    assert.ok(handler);
    assert.doesNotThrow(() => {
      handler({ payload: { model: "x" } }, ctx);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
