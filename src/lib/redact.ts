/**
 * 脱敏（PRD §13 / C5）。
 *
 * ⚠️ **当前生产代码不用它**：2026-10-23 起正文原样存在 `data/payloads/` 的文件里，
 * 不脱敏也不截断（见 PRD C5 与 §8.6）。这个模块留着备用（例如将来只对某一类正文脱敏），
 * 但别以为请求体在写文件前过了它。
 *
 * 两条规则：
 * 1. 按键名黑名单剔除整条字段（不写入库）。
 * 2. 字符串值若形状像凭据（`sk-...`、`Bearer ...`）也替换掉——键名可能被上游改名，值形状不会。
 *
 * 注意：不使用「包含 token 的键名」这种宽泛规则，否则会误伤 `max_tokens`、`tokens` 这类正常字段。
 */

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "auth",
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "private_key",
  "cookie",
  "set-cookie",
  "bearer",
]);

const SENSITIVE_SUFFIXES = ["_secret", "_password", "_passwd", "_private_key", "_api_key", "_access_token"];

/** 形如凭据的值：`sk-` 开头、`Bearer xxx`、`AKIA...` */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^Bearer\s+\S{16,}$/i,
  /^AKIA[0-9A-Z]{12,}$/,
];

export const REDACTED = "[redacted]";

export function isSensitiveKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

export interface RedactResult {
  value: unknown;
  /** 被替换掉的字段路径，例如 `messages[0].authorization`，供界面与日志展示 */
  removed: string[];
}

export function redact(input: unknown, path = ""): RedactResult {
  const removed: string[] = [];

  const walk = (node: unknown, at: string): unknown => {
    if (node === null || node === undefined) return node;

    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${at}[${i}]`));
    }

    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const childPath = at ? `${at}.${key}` : key;
        if (isSensitiveKey(key)) {
          removed.push(childPath);
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(value, childPath);
      }
      return out;
    }

    if (typeof node === "string" && looksSecret(node)) {
      removed.push(at || "(value)");
      return REDACTED;
    }

    return node;
  };

  return { value: walk(input, path), removed };
}

export interface TruncateResult {
  json: string;
  bytes: number;
  truncated: boolean;
}

/**
 * 序列化并按字节上限截断（PRD §7.4：单条 512 KB）。
 * 截断时保留一个合法 JSON 结构：`{"truncated":true,"bytes":<原始字节>}}`，
 * 而不是切断字符串——切断会产出无法解析的 JSON。
 */
export function serializeCapped(value: unknown, maxBytes: number): TruncateResult {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = JSON.stringify({ unserializable: true });
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return { json, bytes, truncated: false };

  return {
    json: JSON.stringify({ truncated: true, bytes }),
    bytes,
    truncated: true,
  };
}
