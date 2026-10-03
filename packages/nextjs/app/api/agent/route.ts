import { NextResponse } from "next/server";
import {
  ACTION_IDS,
  HBAR,
  HEDERA_TESTNET,
  RESERVED_ACTION_IDS,
  buildOwnerIntent,
  buildSessionAction,
  encodePayment,
  receiptToJson,
  signOwnerIntent,
  signSessionAction,
  toSponsorRequest,
} from "@sh/sdk";
import { type Address, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSponsor } from "~~/services/consumer/sponsorServer";

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

const SCENARIOS = ["pay", "overspend", "withdraw", "escalate", "raw-call", "other-recipient"] as const;
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
  const to: Address = body.to && isAddress(body.to) ? getAddress(body.to) : account;
  const amount = BigInt(/^\d+$/.test(body.amount ?? "") ? body.amount! : "1000000");
  const chainId = HEDERA_TESTNET.chainId;
  const action = async (id: `0x${string}`, data: `0x${string}`) => {
    const a = buildSessionAction(id, data);
    return s.sponsor.sponsor.handle(
      toSponsorRequest.sessionAction(chainId, account, a, await signSessionAction(agent, chainId, account, a)),
    );
  };

  let result;
  switch (body.scenario as Scenario) {
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
