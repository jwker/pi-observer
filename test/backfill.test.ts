import assert from "node:assert/strict";
import test from "node:test";

import {
  createJournalReader,
  encodeSessionDirSegment,
  type JournalFs,
} from "../src/lib/backfill.ts";

/** 内存文件系统：sizeOf + readRange，可模拟「stat 之后文件还在变」的撕裂读 */
class FakeFs implements JournalFs {
  files = new Map<string, Buffer>();
  /** 若不为 null，单次 readRange 最多只返回这么多字节（模拟并发写入时的短读） */
  maxReadBytes: number | null = null;

  write(path: string, text: string): void {
    this.files.set(path, Buffer.from(text, "utf8"));
  }

  append(path: string, text: string): void {
    const current = this.files.get(path) ?? Buffer.alloc(0);
    this.files.set(path, Buffer.concat([current, Buffer.from(text, "utf8")]));
  }

  sizeOf(path: string): number {
    const buffer = this.files.get(path);
    if (!buffer) throw new Error(`ENOENT: ${path}`);
    return buffer.length;
  }

  readRange(path: string, offset: number, length: number): Buffer {
    const buffer = this.files.get(path);
    if (!buffer) throw new Error(`ENOENT: ${path}`);
    const wanted = this.maxReadBytes === null ? length : Math.min(length, this.maxReadBytes);
    return Buffer.from(buffer.subarray(offset, offset + wanted));
  }
}

const HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "01a15356-262f-73d0-80a5-8c9ba1394fa5",
  timestamp: "2026-10-19T08:45:17.231Z",
  cwd: "/Users/example/project",
});

function message(id: string, parentId: string | null, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-19T08:45:18.000Z",
    message: { role, content: [{ type: "text", text }] },
  });
}

function lines(...rows: string[]): string {
  return rows.map((row) => `${row}\n`).join("");
}

test("规则 1：只消费以换行结尾的完整行，末尾残片留到下次", () => {
  const fs = new FakeFs();
  const path = "/sessions/a.jsonl";
  const reader = createJournalReader(fs);

  // 末尾故意没有换行
  fs.write(path, `${lines(HEADER, message("e1", null, "user", "第一句"))}${message("e2", "e1", "assistant", "第二句")}`);
  const first = reader.read(path);

  assert.equal(first.ok, true);
  assert.deepEqual(first.entries.map((entry) => entry.entryId), ["e1"]);
  assert.ok(first.warnings.some((line) => line.includes("不完整片段")), "应提示残片被留在缓冲区");
  assert.deepEqual(first.header, {
    sessionId: "01a15356-262f-73d0-80a5-8c9ba1394fa5",
    version: 3,
    cwd: "/Users/example/project",
    timestamp: "2026-10-19T08:45:17.231Z",
    parentSession: null,
  });

  // 补上换行，残片变成完整行
  fs.append(path, "\n");
  const second = reader.read(path);
  assert.deepEqual(second.entries.map((entry) => entry.entryId), ["e2"]);
  assert.equal(second.header, null, "增量读时头部没再出现");
});

test("规则 1：多字节字符被切在两次读之间也不产生乱码", () => {
  const fs = new FakeFs();
  const path = "/sessions/b.jsonl";
  const reader = createJournalReader(fs);

  const line = message("e1", null, "user", "中文内容：看板只读");
  const bytes = Buffer.from(`${lines(HEADER)}${line}\n`, "utf8");
  // 切在一个汉字中间（头部 + 半个汉字）
  const cut = Buffer.from(`${lines(HEADER)}${line}\n`, "utf8").indexOf(Buffer.from("中", "utf8")) + 1;
  fs.write(path, "");
  fs.files.set(path, bytes.subarray(0, cut));
  assert.deepEqual(reader.read(path).entries, [], "只切到半个字符时不该产出条目");

  fs.files.set(path, bytes);
  const result = reader.read(path);
  assert.deepEqual(result.entries.map((entry) => entry.entryId), ["e1"]);
  const raw = result.entries[0].raw as { message: { content: { text: string }[] } };
  assert.equal(raw.message.content[0].text, "中文内容：看板只读");
});

test("增量读：第二次只返回新条目，头部不再重复返回", () => {
  const fs = new FakeFs();
  const path = "/sessions/c.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, message("e1", null, "user", "a")));
  assert.equal(reader.read(path).entries.length, 1);

  const idle = reader.read(path);
  assert.deepEqual(idle.entries, []);
  assert.equal(idle.bytesRead, 0);
  assert.equal(idle.restarted, false);

  fs.append(path, `${message("e2", "e1", "assistant", "b")}\n${message("e3", "e2", "user", "c")}\n`);
  const grown = reader.read(path);
  assert.deepEqual(grown.entries.map((entry) => entry.entryId), ["e2", "e3"]);
  assert.equal(grown.restarted, false);
});

test("规则 2 + 3：文件变小即从头重读，已消费条目按 id 去重", () => {
  const fs = new FakeFs();
  const path = "/sessions/d.jsonl";
  const reader = createJournalReader(fs);

  fs.write(
    path,
    lines(HEADER, message("e1", null, "user", "a"), message("e2", "e1", "assistant", "b".repeat(200))),
  );
  assert.deepEqual(reader.read(path).entries.map((entry) => entry.entryId), ["e1", "e2"]);

  // 模拟整文件重写：内容变短，且把 e1 又写了一遍，e2 换成了 e2b
  fs.write(path, lines(HEADER, message("e1", null, "user", "a"), message("e2b", "e1", "assistant", "b2")));
  const after = reader.read(path);

  assert.equal(after.restarted, true, "变小必须判定为重写");
  assert.deepEqual(
    after.entries.map((entry) => entry.entryId),
    ["e2b"],
    "e1 已消费过不重复产出，e2b 是新的",
  );
});

test("规则 2 的额外保险：截断后重新写（大小没变小）也能识别出重写", () => {
  const fs = new FakeFs();
  const path = "/sessions/e.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, message("e1", null, "user", "a"), message("e2", "e1", "assistant", "x".repeat(300))));
  assert.deepEqual(reader.read(path).entries.map((entry) => entry.entryId), ["e1", "e2"]);

  // 换成另一个会话的头部 + 更长内容（大小更大，单纯比大小看不出来）
  const otherHeader = JSON.stringify({
    type: "session",
    version: 3,
    id: "01a15356-0000-0000-0000-000000000000",
    timestamp: "2026-10-19T09:00:00.000Z",
    cwd: "/Users/example/other",
  });
  fs.write(
    path,
    lines(otherHeader, message("n1", null, "user", "y".repeat(700)), message("n2", "n1", "assistant", "z")),
  );

  const after = reader.read(path);
  assert.equal(after.restarted, true);
  assert.deepEqual(after.entries.map((entry) => entry.entryId), ["n1", "n2"]);
  assert.equal(after.header?.cwd, "/Users/example/other");
});

test("正常追加写入不会误判成重写（尾锚只比已消费区域）", () => {
  const fs = new FakeFs();
  const path = "/sessions/e2.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, message("e1", null, "user", "a".repeat(400))));
  assert.equal(reader.read(path).entries.length, 1);

  for (let i = 2; i <= 5; i += 1) {
    fs.append(path, `${message(`e${i}`, `e${i - 1}`, "assistant", `第 ${i} 条`.repeat(30))}\n`);
    const result = reader.read(path);
    assert.equal(result.restarted, false, `第 ${i} 次追加不该被判为重写`);
    assert.deepEqual(result.entries.map((entry) => entry.entryId), [`e${i}`]);
  }
});

test("规则 4：坏行跳过并记警告，其余条目照常解析", () => {
  const fs = new FakeFs();
  const path = "/sessions/f.jsonl";
  const reader = createJournalReader(fs);

  fs.write(
    path,
    `${lines(HEADER, message("e1", null, "user", "a"))}{"type":"message","id":"broken"\n${lines(
      message("e2", "e1", "assistant", "b"),
    )}[1,2,3]\n{"type":"usage","tokens":9}\n`,
  );
  const result = reader.read(path);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.entryId),
    ["e1", "e2", null],
    "合法条目照常产出，最后一条没有 id",
  );
  assert.equal(result.warnings.length, 3, `实际警告：${JSON.stringify(result.warnings)}`);
  assert.ok(result.warnings.some((line) => line.includes("第 3 行不是合法 JSON")));
  assert.ok(result.warnings.some((line) => line.includes("第 5 行不是对象")));
  assert.ok(result.warnings.some((line) => line.includes("没有 id")));
});

test("规则 5：不加锁——stat 之后文件又变了（短读）也不报错，下次补齐", () => {
  const fs = new FakeFs();
  const path = "/sessions/g.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, message("e1", null, "user", "a"), message("e2", "e1", "assistant", "b")));
  fs.maxReadBytes = 20; // 每次只给 20 字节

  const first = reader.read(path);
  assert.equal(first.ok, true);
  assert.ok(first.entries.length < 2, "短读时只能读到部分条目");

  // 反复读，直到短读把剩下的字节补齐
  const collected = new Set(first.entries.map((entry) => entry.entryId));
  for (let i = 0; i < 30; i += 1) {
    const next = reader.read(path);
    assert.equal(next.ok, true);
    for (const entry of next.entries) collected.add(entry.entryId ?? "");
  }
  assert.deepEqual([...collected].sort(), ["e1", "e2"]);
});

test("没有 id 的条目：如实产出并记一条警告（无法去重）", () => {
  const fs = new FakeFs();
  const path = "/sessions/h.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, JSON.stringify({ type: "usage", timestamp: "2026-10-19T08:45:19.000Z", tokens: 12 })));
  const result = reader.read(path);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].entryId, null);
  assert.equal(result.entries[0].type, "usage");
  assert.ok(result.warnings.some((line) => line.includes("没有 id")));
});

test("边界：文件不存在、空文件、只有头部", () => {
  const fs = new FakeFs();
  const reader = createJournalReader(fs);

  const missing = reader.read("/sessions/none.jsonl");
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /读不到会话文件/);
  assert.deepEqual(missing.entries, []);

  fs.write("/sessions/empty.jsonl", "");
  const empty = reader.read("/sessions/empty.jsonl");
  assert.equal(empty.ok, true);
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.entries, []);

  fs.write("/sessions/head.jsonl", lines(HEADER));
  const head = reader.read("/sessions/head.jsonl");
  assert.equal(head.entries.length, 0);
  assert.equal(head.header?.sessionId, "01a15356-262f-73d0-80a5-8c9ba1394fa5");
  assert.equal(head.header?.version, 3);
});

test("头部字段：分叉会话带 parentSession，缺 id/cwd 时忽略并警告", () => {
  const fs = new FakeFs();
  const reader = createJournalReader(fs);

  const fork = JSON.stringify({
    type: "session",
    version: 3,
    id: "child",
    timestamp: "2026-10-19T08:00:00.000Z",
    cwd: "/w",
    parentSession: "parent-id",
  });
  fs.write("/sessions/fork.jsonl", lines(fork));
  assert.equal(reader.read("/sessions/fork.jsonl").header?.parentSession, "parent-id");

  fs.write("/sessions/broken-header.jsonl", lines(JSON.stringify({ type: "session", version: 3, id: "x" })));
  const broken = reader.read("/sessions/broken-header.jsonl");
  assert.equal(broken.header, null);
  assert.ok(broken.warnings.some((line) => line.includes("缺 id 或 cwd")));
});

test("reset 之后从头读，条目会再产出一次（供测试与手工重扫使用）", () => {
  const fs = new FakeFs();
  const path = "/sessions/i.jsonl";
  const reader = createJournalReader(fs);

  fs.write(path, lines(HEADER, message("e1", null, "user", "a")));
  assert.equal(reader.read(path).entries.length, 1);
  assert.equal(reader.read(path).entries.length, 0, "增量读不重复");
  reader.reset(path);
  assert.equal(reader.read(path).entries.length, 1, "reset 后重新产出（由上层 upsert 保证幂等）");
});

test("会话目录名编码：去掉开头分隔符，把分隔符与冒号换成 -，两侧包 --", () => {
  assert.equal(encodeSessionDirSegment("/Users/example/project"), "--Users-example-project--");
  assert.equal(encodeSessionDirSegment("C:\\work\\demo"), "--C--work-demo--");
  assert.equal(encodeSessionDirSegment("/Users/example/.pi/agent"), "--Users-example-.pi-agent--");
});
