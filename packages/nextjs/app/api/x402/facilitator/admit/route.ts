import { NextResponse } from "next/server";
import { getX402 } from "~~/services/consumer/x402Server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Executor admission (this facilitator's policy, not part of the x402 wire protocol): a ConsumerAccount deployed by
 * this app's factory is added to the `executors` list advertised in PaymentRequirements.extra.
 */
export async function POST(req: Request) {
  const x = getX402();
  if (!x.ok) return NextResponse.json({ error: "X402_NOT_CONFIGURED", missing: x.missing }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { account?: string } | null;
  if (!body?.account) return NextResponse.json({ error: "expected { account }" }, { status: 400 });
  try {
    return NextResponse.json({ executor: await x.x.facilitator.admit(body.account) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
