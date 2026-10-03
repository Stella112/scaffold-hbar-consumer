import { NextResponse } from "next/server";
import { HBAR, X402_HBAR_ASSET, X402_HEDERA_TESTNET, X402_SCHEME, X402_VERSION, testnetDeployment } from "@sh/sdk";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { parseAbi } from "viem";
import { getSponsor } from "~~/services/consumer/sponsorServer";
import { PREMIUM_PRICE_TINYBARS, getX402 } from "~~/services/consumer/x402Server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * x402-protected resource (x402 v2 HTTP transport): no PAYMENT-SIGNATURE → 402 with PAYMENT-REQUIRED; a valid
 * payment is verified and settled by the in-process transferExecutor facilitator before the data is returned.
 */
export async function GET(req: Request) {
  const x = getX402();
  const merchant = process.env.MERCHANT_ACCOUNT_ID;
  if (!x.ok || !merchant) return NextResponse.json({ error: "X402_NOT_CONFIGURED" }, { status: 503 });

  const requirements: PaymentRequirements = {
    scheme: X402_SCHEME,
    network: X402_HEDERA_TESTNET,
    asset: X402_HBAR_ASSET,
    amount: PREMIUM_PRICE_TINYBARS.toString(),
    payTo: merchant,
    maxTimeoutSeconds: 120,
    extra: x.x.facilitator.getExtra(X402_HEDERA_TESTNET) ?? {},
  };
  const paymentRequired = (error?: string): PaymentRequired => ({
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: {
      url: req.url,
      description: "Live HBAR/USD reading from the Supra oracle",
      mimeType: "application/json",
    },
    accepts: [requirements],
  });
  const require402 = (error?: string, extraHeaders: Record<string, string> = {}) => {
    const body = paymentRequired(error);
    return NextResponse.json(body, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body),
        "Cache-Control": "private, no-store",
        ...extraHeaders,
      },
    });
  };

  const header = req.headers.get("payment-signature");
  if (!header) return require402();

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return require402("invalid_payment_signature_header");
  }
  // Verify and settle against this server's requirements, never the client's echo of them.
  const verified = await x.x.x402.verify(payload, requirements);
  if (!verified.isValid) return require402(verified.invalidReason ?? "invalid_payment");
  const settled = await x.x.x402.settle(payload, requirements);
  const responseHeader = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) };
  if (!settled.success) return require402(settled.errorReason ?? "settlement_failed", responseHeader);

  return NextResponse.json(await premiumData(), {
    headers: { ...responseHeader, "Cache-Control": "private, no-store" },
  });
}

async function premiumData() {
  const s = getSponsor();
  const oracle = testnetDeployment.oracle;
  if (!s.ok || !oracle) return { hbarUsd: null, source: "no oracle configured" };
  const [ok, usd6] = await s.sponsor.publicClient.readContract({
    address: oracle.address,
    abi: parseAbi(["function quoteUsd6(address asset, uint256 amount) view returns (bool ok, uint256 usd6)"]),
    functionName: "quoteUsd6",
    args: [HBAR, 100_000_000n],
  });
  return {
    hbarUsd: ok ? Number(usd6) / 1e6 : null,
    fresh: ok,
    source: oracle.label,
    oracle: oracle.contractId ?? oracle.address,
    readAt: new Date().toISOString(),
  };
}
