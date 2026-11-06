import { AppShell } from "@/components/app-shell.tsx";
import { listSessionItems, loadSessionWindow } from "@/lib/session-view.ts";
import type { SessionWindow } from "@/lib/types.ts";

export const dynamic = "force-dynamic";

/**
 * 单页看板：左栏项目 / 会话，右栏直接打开时间线。
 *
 * `?session=<id>` 与当前会话同步；没有参数时选中最近改动的那个。
 * 服务端渲染时读一次文件，之后的刷新都由页面上的按钮触发。
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.session) ? params.session[0] : params.session;
  const sessions = listSessionItems(500);
  const selected = sessions.find((session) => session.session_id === requested) ?? sessions[0] ?? null;
  const selectedId = selected?.session_id ?? null;

  let data: SessionWindow | null = null;
  if (selectedId !== null) {
    try {
      data = await loadSessionWindow(selectedId, { turns: 20 });
    } catch {
      data = null;
    }
  }

  return (
    <AppShell
      initialSessions={sessions}
      initialTotal={sessions.length}
      initialSessionId={selectedId}
      initialData={data}
    />
  );
}
