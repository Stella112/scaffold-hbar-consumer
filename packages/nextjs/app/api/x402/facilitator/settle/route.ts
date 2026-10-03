import { NextResponse } from "next/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getX402 } from "~~/services/consumer/x402Server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 facilitator `POST /settle` with { paymentPayload, paymentRequirements }. */
export async function POST(req: Request) {
  const x = getX402();
  if (!x.ok) return NextResponse.json({ error: "X402_NOT_CONFIGURED", missing: x.missing }, { status: 503 });
  const body = (await req.json().catch(() => null)) as {
    paymentPayload?: PaymentPayload;
    paymentRequirements?: PaymentRequirements;
  } | null;
  if (!body?.paymentPayload || !body.paymentRequirements) {
    return NextResponse.json({ error: "expected { paymentPayload, paymentRequirements }" }, { status: 400 });
  }
  return NextResponse.json(await x.x.x402.settle(body.paymentPayload, body.paymentRequirements));
}
