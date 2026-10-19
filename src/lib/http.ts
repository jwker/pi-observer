/** 收请求体并按字节上限截断（框架不兜底，见技术选型 T7 / 附录 C.5） */

export type ReadBodyResult = { ok: true; text: string } | { ok: false; reason: string };

export async function readBodyCapped(req: Request, maxBytes: number): Promise<ReadBodyResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return { ok: false, reason: `请求体声明长度 ${declaredBytes} 超过上限 ${maxBytes} 字节` };
    }
  }

  const body = req.body;
  if (!body) return { ok: false, reason: "空请求体" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: `请求体超过上限 ${maxBytes} 字节` };
      }
      chunks.push(value);
    }
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder().decode(buffer) };
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
