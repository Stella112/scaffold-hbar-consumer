import { getSponsor } from "./sponsorServer";
import { TransferExecutorFacilitator } from "@sh/relayer";
import { HEDERA_TESTNET, MirrorClient, X402_HEDERA_TESTNET, requireDeployment } from "@sh/sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Server-only x402 facilitator (exact / transferExecutor) for Next.js API routes. The sponsor account is the fee
 * payer; executors are ConsumerAccounts deployed by this app's factory. Never import from a client component.
 */
type Instance = { facilitator: TransferExecutorFacilitator; x402: x402Facilitator };
let instance: Instance | null = null;

export type X402Availability = { ok: true; x: Instance } | { ok: false; missing: string[] };

export function getX402(): X402Availability {
  if (instance) return { ok: true, x: instance };
  const s = getSponsor();
  if (!s.ok) return s;
  const cfg = s.sponsor.cfg;
  const key = (
    cfg.SPONSOR_PRIVATE_KEY.startsWith("0x") ? cfg.SPONSOR_PRIVATE_KEY : `0x${cfg.SPONSOR_PRIVATE_KEY}`
  ) as `0x${string}`;
  const facilitator = new TransferExecutorFacilitator({
    publicClient: s.sponsor.publicClient,
    chainId: HEDERA_TESTNET.chainId,
    mirror: new MirrorClient({ baseUrl: cfg.MIRROR_NODE_URL }),
    factory: requireDeployment("factory"),
    feePayerAccountId: cfg.SPONSOR_ACCOUNT_ID,
    feePayerKey: key,
    feePayerEvm: privateKeyToAccount(key).address,
    dataDir: process.env.VERCEL ? "/tmp/relayer" : cfg.RELAYER_DATA_DIR,
    auditor: s.sponsor.auditor,
  });
  instance = { facilitator, x402: new x402Facilitator().register(X402_HEDERA_TESTNET, facilitator) };
  return { ok: true, x: instance };
}

/** Price of the demo paid resource: 0.05 HBAR, paid to the merchant account. */
export const PREMIUM_PRICE_TINYBARS = 5_000_000n;
