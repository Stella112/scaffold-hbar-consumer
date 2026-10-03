import { NextResponse } from "next/server";
import { toMirrorTransactionId } from "@sh/relayer";
import {
  ACTION_IDS,
  HBAR,
  HEDERA_TESTNET,
  MirrorClient,
  RESERVED_ACTION_IDS,
  TransferExecutorClient,
  X402_HEDERA_TESTNET,
  buildOwnerIntent,
  buildSessionAction,
  encodePayment,
  hashscanTx,
  receiptToJson,
  resolveX402PayTo,
  signOwnerIntent,
  signSessionAction,
  toSponsorRequest,
  x402HbarSpendControls,
} from "@sh/sdk";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { type Address, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSponsor } from "~~/services/consumer/sponsorServer";
import { getX402 } from "~~/services/consumer/x402Server";

const mirror = () => new MirrorClient({ baseUrl: process.env.MIRROR_NODE_URL ?? HEDERA_TESTNET.mirrorUrl });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scripted demo agent (not an LLM). Holds AGENT_PRIVATE_KEY server-side and signs only typed session actions
 * (plus deliberate attack attempts) for an account that granted it a session. The contract is the authority.
 */
const agentKey = () => {
  const k = process.env.AGENT_PRIVATE_KEY;
  return k && /^(0x)?[0-9a-fA-F]{64}$/.test(k)
    ? privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`)
    : null;
};

export async function GET() {
  const a = agentKey();
  return NextResponse.json({ configured: Boolean(a), address: a?.address ?? null, kind: "Scripted demo agent" });
}

const SCENARIOS = ["pay", "x402", "overspend", "withdraw", "escalate", "raw-call", "other-recipient"] as const;
type Scenario = (typeof SCENARIOS)[number];

export async function POST(req: Request) {
  const agent = agentKey();
  const s = getSponsor();
  if (!agent || !s.ok) return NextResponse.json({ error: "AGENT_NOT_CONFIGURED" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as {
    account?: string;
    scenario?: string;
    to?: string;
    amount?: string;
  };
  if (!body.account || !isAddress(body.account) || !SCENARIOS.includes(body.scenario as Scenario)) {
    return NextResponse.json({ error: "expected { account, scenario }" }, { status: 400 });
  }
  const account = getAddress(body.account);
  // Default recipient: the demo merchant, at the same address x402 settles to (its EVM alias).
  const merchant = process.env.MERCHANT_ACCOUNT_ID
    ? await resolveX402PayTo(mirror(), process.env.MERCHANT_ACCOUNT_ID).catch(() => account)
    : account;
  const to: Address = body.to && isAddress(body.to) ? getAddress(body.to) : merchant;
  const amount = BigInt(/^\d+$/.test(body.amount ?? "") ? body.amount! : "1000000");
  const chainId = HEDERA_TESTNET.chainId;
  const action = async (id: `0x${string}`, data: `0x${string}`) => {
    const a = buildSessionAction(id, data);
    return s.sponsor.sponsor.handle(
      toSponsorRequest.sessionAction(chainId, account, a, await signSessionAction(agent, chainId, account, a)),
    );
  };

  if (body.scenario === "x402") return NextResponse.json(await payWithX402(req, agent, account));

  let result;
  switch (body.scenario as Exclude<Scenario, "x402">) {
    case "pay":
      result = await action(ACTION_IDS.payment, encodePayment({ asset: HBAR, to, amount }));
      break;
    case "overspend":
      result = await action(ACTION_IDS.payment, encodePayment({ asset: HBAR, to, amount: amount * 1_000n }));
      break;
    case "other-recipient":
      result = await action(ACTION_IDS.payment, encodePayment({ asset: HBAR, to: agent.address, amount }));
      break;
    case "withdraw":
      result = await action(RESERVED_ACTION_IDS.vaultWithdraw, "0x");
      break;
    case "escalate":
      result = await action(RESERVED_ACTION_IDS.adminSetOwner, "0x");
      break;
    case "raw-call": {
      const intent = buildOwnerIntent([{ target: agent.address, value: amount, data: "0x" }]);
      result = await s.sponsor.sponsor.handle(
        toSponsorRequest.ownerIntent(chainId, account, intent, await signOwnerIntent(agent, chainId, account, intent)),
      );
      break;
    }
  }
  return new NextResponse(
    `{"agent":"Scripted demo agent","scenario":"${body.scenario}","receipt":${receiptToJson(result.receipt)},"auditError":${JSON.stringify(result.auditError)}}`,
    {
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * The agent buys the paid resource over real HTTP: GET → 402 + PAYMENT-REQUIRED, sign a TransferAuthorization with
 * its session key, retry with PAYMENT-SIGNATURE, receive the data + PAYMENT-RESPONSE. The account's on-chain session
 * policy (x402-payment action, USD caps, recipients) decides whether the transfer happens.
 */
async function payWithX402(req: Request, agent: ReturnType<typeof privateKeyToAccount>, account: Address) {
  const x = getX402();
  if (!x.ok) return { agent: "Scripted demo agent", scenario: "x402", error: "X402_NOT_CONFIGURED" };
  const steps: string[] = [];
  try {
    const executor = await x.x.facilitator.admit(account);
    steps.push(`facilitator admitted executor ${executor}`);
    const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    const url = `${proto}://${host}/api/x402/premium`;

    const first = await fetch(url, { cache: "no-store" });
    steps.push(`GET ${url} → ${first.status}`);
    const requiredHeader = first.headers.get("payment-required");
    if (first.status !== 402 || !requiredHeader) throw new Error("resource did not ask for payment");
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
    const offer = paymentRequired.accepts[0]!;
    steps.push(
      `402 asks ${offer.amount} tinybars of ${offer.asset} to ${offer.payTo} (${String(offer.extra.assetTransferMethod)})`,
    );

    const client = new x402Client()
      .register(
        X402_HEDERA_TESTNET,
        new TransferExecutorClient({
          signer: agent,
          chainId: HEDERA_TESTNET.chainId,
          account,
          accountId: executor,
          mirror: mirror(),
        }),
      )
      .setSpendControls(x402HbarSpendControls(100_000_000n));
    const payload = await client.createPaymentPayload(paymentRequired);
    steps.push("agent signed TransferAuthorization with its session key");

    const second = await fetch(url, {
      cache: "no-store",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    const responseHeader = second.headers.get("payment-response");
    const settlement = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
    const data = await second.json().catch(() => null);
    steps.push(`retry with PAYMENT-SIGNATURE → ${second.status}`);
    return {
      agent: "Scripted demo agent",
      scenario: "x402",
      ok: second.status === 200 && settlement?.success === true,
      steps,
      settlement,
      hashscan: settlement?.transaction ? hashscanTx(toMirrorTransactionId(settlement.transaction)) : null,
      data: second.status === 200 ? data : null,
      error:
        second.status === 200 ? null : ((data as { error?: string } | null)?.error ?? settlement?.errorReason ?? null),
    };
  } catch (e) {
    return { agent: "Scripted demo agent", scenario: "x402", ok: false, steps, error: (e as Error).message };
  }
}
