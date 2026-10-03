import { NextResponse } from "next/server";
import { getX402 } from "~~/services/consumer/x402Server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 facilitator `GET /supported`: exact on hedera:testnet with the transferExecutor method. */
export async function GET() {
  const x = getX402();
  if (!x.ok) return NextResponse.json({ error: "X402_NOT_CONFIGURED", missing: x.missing }, { status: 503 });
  return NextResponse.json(x.x.x402.getSupported());
}
