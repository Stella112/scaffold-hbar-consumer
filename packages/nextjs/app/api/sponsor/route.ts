import { NextResponse } from "next/server";
import { receiptToJson } from "@sh/sdk";
import { getSponsor } from "~~/services/consumer/sponsorServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

/** Sponsored execution: the body is a signed SponsorRequest; the sponsor pays the Hedera fee. */
export async function POST(req: Request) {
  const s = getSponsor();
  if (!s.ok) return NextResponse.json({ error: "SPONSOR_NOT_CONFIGURED", missing: s.missing }, { status: 503 });
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { receipt, auditError } = await s.sponsor.sponsor.handle(body);
  return new NextResponse(`{"receipt":${receiptToJson(receipt)},"auditError":${JSON.stringify(auditError)}}`, {
    status: receipt.status === "success" ? 200 : 422,
    headers: { "content-type": "application/json" },
  });
}
