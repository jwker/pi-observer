import { installProbe, probeInstallStatus, uninstallProbe } from "@/lib/probe-install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 探针的安装与卸载。
 *
 * GET  查当前状态（装没装、入口文件在哪儿、什么时候装的）
 * POST 动作：`{"action":"install"}` 或 `{"action":"uninstall"}`
 *
 * 写用户的 Pi 配置目录是有副作用的操作，所以都要人明确发起，
 * 不做「启动时自动装」。
 */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, status: probeInstallStatus() });
  } catch (error) {
    return Response.json(
      { ok: false, error: `读探针状态失败：${(error as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: { action?: string; overwrite?: boolean; removeData?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    if (body.action === "install") {
      const result = installProbe({ overwrite: body.overwrite === true });
      return Response.json({ ...result }, { status: result.ok ? 200 : 409 });
    }
    if (body.action === "uninstall") {
      const result = uninstallProbe({ removeData: body.removeData === true });
      return Response.json({ ...result }, { status: result.ok ? 200 : 409 });
    }
    return Response.json({ ok: false, error: "动作不对：只认 install 与 uninstall" }, { status: 400 });
  } catch (error) {
    return Response.json(
      { ok: false, error: `操作失败：${(error as Error).message}` },
      { status: 500 },
    );
  }
}
