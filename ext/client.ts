/**
 * 探针的 HTTP 客户端：批量推送 + 指数退避 + 健康探测。
 * 注入 `fetchImpl` 以便在 `node --test` 里断言退避与丢弃行为。
 */
import type { IngestBatch, IngestResponse } from "../src/lib/protocol.ts";

export interface ResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ResponseLike>;

/**
 * 退避档位：1s → 2s → 5s → 10s → 15s（之后停在 15s）。
 * 上限取 15s 而不是 30s：看板是本机服务，服务端重启是人工动作，
 * 超过 15 秒才恢复入库会显得「看板坏了」，而重试成本只是一次本机连接失败。
 */
export const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000, 15000];

export function backoffDelay(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 0), BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[index];
}

export type PostOutcome =
  | { ok: true; applied: Record<string, number>; status: number }
  | { ok: false; retryable: boolean; reason: string; status: number | null };

/**
 * 哪些状态可以重试：
 *   - 5xx / 408 / 429：服务端或网络暂时不行，退避后再发；
 *   - 401：令牌不对。服务端重新生成 `data/token` 时探针缓存的旧值会让每一批都失败，
 *     丢数据毫无意义，改为让调用方清掉缓存重读文件再试（见 flush 的 onUnauthorized）；
 *   - 404 / 405：路由不存在或方法不匹配（例如探针指向了别的服务、或dev 正在重编译该路由）。
 *     同样先重试，否则配置错误会静默丢数据；退避上限 15s，不会刷屏。
 *
 * 不可重试的只有 400（形状 / 协议不对，重发还是错）与 413（这批就是太大）。
 */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 401 || status === 404 || status === 405 || status === 408 || status === 429;
}

export async function postBatch(options: {
  url: string;
  token: string;
  batch: IngestBatch;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PostOutcome> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as Promise<ResponseLike>);
  const timeoutMs = options.timeoutMs ?? 10000;

  let body: string;
  try {
    body = JSON.stringify(options.batch);
  } catch (error) {
    return { ok: false, retryable: false, reason: `序列化失败：${(error as Error).message}`, status: null };
  }

  try {
    const response = await doFetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-observer-token": options.token,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text().catch(() => "");

    if (response.status >= 200 && response.status < 300) {
      let applied: Record<string, number> = {};
      try {
        const parsed = JSON.parse(text) as IngestResponse;
        applied = parsed.applied ?? {};
      } catch {
        // 服务端返回体解析失败不算致命
      }
      return { ok: true, applied, status: response.status };
    }

    return {
      ok: false,
      retryable: isRetryable(response.status),
      reason: `HTTP ${response.status} ${text.slice(0, 200)}`,
      status: response.status,
    };
  } catch (error) {
    // 网络错误 / 超时 / 服务未启动 → 可重试
    return { ok: false, retryable: true, reason: (error as Error).message, status: null };
  }
}

export async function checkHealth(options: {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<boolean> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as Promise<ResponseLike>);
  try {
    const response = await doFetch(options.url, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

export interface RemoteCursor {
  requestSeq: number;
  runSeq: number;
}

/**
 * 从看板读「这个会话已经用到的最大序号」，只在本地游标缺失时调用。
 * 服务端不可达、接口不存在、返回体不合法都返回 null，不阻断会话启动。
 */
export async function getSessionCursor(options: {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<RemoteCursor | null> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as Promise<ResponseLike>);
  try {
    const response = await doFetch(options.url, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 300),
    });
    if (response.status < 200 || response.status >= 300) return null;
    const parsed = JSON.parse(await response.text()) as { request_seq_max?: unknown; run_seq_max?: unknown };
    const requestSeq = typeof parsed.request_seq_max === "number" ? parsed.request_seq_max : 0;
    const runSeq = typeof parsed.run_seq_max === "number" ? parsed.run_seq_max : 0;
    return { requestSeq: Math.max(0, Math.trunc(requestSeq)), runSeq: Math.max(0, Math.trunc(runSeq)) };
  } catch {
    return null;
  }
}
