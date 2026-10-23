import { storageUsage } from "@/lib/storage.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 存储用量：数据库与正文文件分别多少。
 *
 * 正文改成存文件之后，数据库只剩索引，占用可以忽略；真正占地方的是
 * `data/payloads/`。设置页拿这个接口显示两边分别的占用。
 */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, usage: storageUsage() });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
