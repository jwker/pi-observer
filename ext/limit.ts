/**
 * 单条记录的体积上限（PRD §7.4：单条 512 KB）。
 *
 * ⚠️ 正文改走文件后，生产代码不再用它截断正文（正文不截断）。留着备用。
 * 超限时用「合法 JSON 标记」替换内容，而不是把字符串切断——切断会产出无法解析的 JSON。
 */

export function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : 0;
  } catch {
    return 0;
  }
}

export interface Capped {
  value: unknown;
  truncated: boolean;
  bytes: number;
}

export function capValue(value: unknown, maxBytes: number): Capped {
  const bytes = jsonBytes(value);
  if (bytes <= maxBytes) return { value, truncated: false, bytes };
  return { value: { truncated: true, bytes }, truncated: true, bytes };
}

export function capText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;

  // 按字节切完再回退到合法字符边界：直接 toString 会把多字节字符切成 U+FFFD
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1; // 跳过续字节
  if (end > 0) {
    const lead = buffer[end - 1];
    const need = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
    if (need > 0 && buffer.length - (end - 1) < need) end -= 1; // 首字节不完整，一并丢掉
  }

  return `${buffer.subarray(0, end).toString("utf8")}\n…[已截断，原始 ${bytes} 字节]`;
}
