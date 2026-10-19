import Link from "next/link";
import { notFound } from "next/navigation";

import { RequestDetailView } from "@/components/request-detail.tsx";
import { getDb } from "@/lib/db.ts";
import { shortId } from "@/lib/format.ts";
import { getRequestDetail, getSession } from "@/lib/queries.ts";
import { requestLabel, requestStatusMeta } from "@/lib/request-view.ts";

export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string; seq: string }> }) {
  const { id, seq } = await params;
  const requestSeq = Number(seq);
  if (!Number.isSafeInteger(requestSeq) || requestSeq < 1) notFound();

  const db = getDb();
  const request = getRequestDetail(id, requestSeq, db);
  if (request === null) notFound();

  const session = getSession(id, db);
  const status = requestStatusMeta(request.status);

  return (
    <div className="page narrow">
      <div className="page-head">
        <div className="title">
          <div className="crumb">
            <Link href="/">会话列表</Link> / <Link href={`/sessions/${encodeURIComponent(id)}`}>{shortId(id)}</Link> / 请求 #
            {request.request_seq}
          </div>
          <h1>{requestLabel(request.provider, request.api, request.model)}</h1>
        </div>
        <div className="spacer" />
        <span className={status.className} title={status.title}>
          {status.label}
          {request.status !== null && request.status >= 200 && request.status < 300 ? " OK" : ""}
        </span>
        {request.payload_truncated === 1 ? <span className="badge warn">payload 已截断</span> : null}
        <span className="badge info">按顺序关联</span>
      </div>

      <RequestDetailView sessionId={id} sessionCwd={session?.cwd ?? ""} request={request} />
    </div>
  );
}
