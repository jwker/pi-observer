/** 请求视图的纯逻辑（PRD §11.2 视图二）；不依赖 React，可直接被 node --test 覆盖 */

export interface StatusMeta {
  label: string;
  className: string;
  title: string;
}

export function requestStatusMeta(status: number | null): StatusMeta {
  if (status === null) {
    return {
      label: "未响应",
      className: "badge warn",
      title: "请求已发出，但还没收到 after_provider_response（中断、失败或仍在进行）",
    };
  }
  if (status >= 200 && status < 300) {
    return { label: String(status), className: "badge ok", title: `HTTP ${status}` };
  }
  if (status >= 300 && status < 400) {
    return { label: String(status), className: "badge info", title: `HTTP ${status}` };
  }
  if (status >= 400 && status < 500) {
    return { label: String(status), className: "badge warn", title: `HTTP ${status}` };
  }
  return { label: String(status), className: "badge err", title: `HTTP ${status}` };
}

export function requestLabel(provider: string | null, api: string | null, model: string | null): string {
  const parts = [provider ?? "—", api ?? "—", model ?? "—"];
  return parts.join(" / ");
}

export interface PayloadSection {
  key: string;
  label: string;
  /** 这一段的 JSON 字节数 */
  bytes: number;
  /** 数组条数或对象键数；标量为 null */
  count: number | null;
  /** 截到 maxChars 的 JSON 文本 */
  preview: string;
  truncated: boolean;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function preview(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…[只显示前 ${maxChars} 个字符，完整内容在库里]`, truncated: true };
}

/**
 * 把 payload 按顶层键拆成可折叠的段。空对象也给出一个「payload」段，
 * 避免界面看起来像「没有 payload」。超长内容只给预览，不把 512 KB 全部塞进 DOM。
 */
export function payloadSections(payload: unknown, maxChars = 12_000): PayloadSection[] {
  if (payload === null || payload === undefined) return [];

  const build = (key: string, label: string, value: unknown, count: number | null): PayloadSection => {
    const json = stringify(value);
    const carved = preview(json, maxChars);
    return {
      key,
      label,
      bytes: byteLength(json),
      count,
      preview: carved.text,
      truncated: carved.truncated,
    };
  };

  if (Array.isArray(payload)) return [build("payload", "payload（数组）", payload, payload.length)];
  if (typeof payload !== "object") return [build("payload", "payload", payload, null)];

  const record = payload as Record<string, unknown>;
  if (record.truncated === true) {
    return [build("truncated", "已截断的 payload", record, null)];
  }

  const entries = Object.entries(record);
  if (entries.length === 0) return [build("payload", "payload（空对象）", payload, 0)];

  return entries.map(([key, value]) =>
    build(
      key,
      key,
      value,
      Array.isArray(value) ? value.length : typeof value === "object" && value !== null ? Object.keys(value).length : null,
    ),
  );
}

/** 从关联 Turn 的助手消息 usage 里取缓存读数；取不到就返回 null，不猜 */
export function cacheUsage(usage: unknown): { read: number | null; write: number | null } {
  if (typeof usage !== "object" || usage === null) return { read: null, write: null };
  const record = usage as Record<string, unknown>;
  const read = typeof record.cacheRead === "number" ? record.cacheRead : null;
  const write = typeof record.cacheWrite === "number" ? record.cacheWrite : null;
  return { read, write };
}
