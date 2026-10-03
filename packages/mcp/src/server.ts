import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTION_IDS,
  ConsumerAccountReader,
  HBAR,
  HEDERA_TESTNET,
  MirrorClient,
  TransferExecutorClient,
  X402_HEDERA_TESTNET,
  buildSessionAction,
  encodePayment,
  entityIdToLongZero,
  hashscanTx,
  isEntityId,
  resolveX402PayTo,
  signSessionAction,
  testnetDeployment,
  toMirrorTransactionId,
  toSponsorRequest,
  x402HbarSpendControls,
} from "@sh/sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import {
  type Address,
  type LocalAccount,
  type PublicClient,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseUnits,
} from "viem";
import { z } from "zod";

export type ConsumerMcpConfig = {
  /** ConsumerAccount EVM address the agent spends from. */
  account: Address;
  /** The agent's session key (granted by the account owner). Never the owner key. */
  agent: LocalAccount;
  /** Base URL of a Scaffold-HBAR Consumer app (its /api/sponsor and /api/x402 endpoints). */
  appUrl: string;
  rpcUrl?: string;
  mirrorUrl?: string;
  /** Client-side cap per x402 payment, in tinybars (the account's USD caps still apply on chain). */
  maxX402Tinybars?: bigint;
  fetchImpl?: typeof fetch;
};

const ASSETS = { HBAR: { decimals: 8 }, USDC: { decimals: 6 }, WHBAR: { decimals: 8 } } as const;
type AssetSymbol = keyof typeof ASSETS;

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, bigintSafe, 2) }],
  ...(isError ? { isError: true } : {}),
});
const bigintSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const usd = (usd6: bigint) => `$${(Number(usd6) / 1e6).toFixed(2)}`;

/**
 * MCP server for an AI agent holding a ConsumerAccount session key. Every spend goes through the account's typed
 * session actions, so the contract enforces the owner's caps, recipients and expiry; denials come back with the
 * on-chain reason code so the model can explain them.
 */
export function createConsumerMcpServer(cfg: ConsumerMcpConfig): McpServer {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const appUrl = cfg.appUrl.replace(/\/$/, "");
  const chainId = HEDERA_TESTNET.chainId;
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl ?? HEDERA_TESTNET.rpcUrl) }) as PublicClient;
  const mirror = new MirrorClient({ baseUrl: cfg.mirrorUrl ?? HEDERA_TESTNET.mirrorUrl });
  const reader = new ConsumerAccountReader(publicClient, cfg.account);
  const server = new McpServer({ name: "consumer-account", version: "0.1.0" });

  const resolveRecipient = async (to: string): Promise<Address> => {
    if (isAddress(to)) return getAddress(to);
    if (isEntityId(to)) return resolveX402PayTo(mirror, to);
    throw new Error(`recipient must be a Hedera account id (0.0.x) or 0x address, got ${to}`);
  };
  const assetAddress = (symbol: AssetSymbol): Address => {
    if (symbol === "HBAR") return HBAR;
    const t = testnetDeployment.tokens?.[symbol];
    if (!t) throw new Error(`${symbol} is not in this deployment`);
    return t.address ?? entityIdToLongZero(t.tokenId);
  };

  server.registerTool(
    "get_allowance",
    {
      title: "Get spending allowance",
      description:
        "Shows what this agent may spend from the account right now: per-payment and daily USD caps, amount spent " +
        "today, expiry, whether recipients are restricted, and the live HBAR/USD price used to value payments.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const s = await reader.session(cfg.agent.address);
      if (s.epoch === 0n) return text("No active allowance: the owner has not granted this agent a session.");
      let hbarUsd: string | null = null;
      const oracle = testnetDeployment.oracle;
      if (oracle) {
        const [ok, usd6] = await publicClient.readContract({
          address: oracle.address,
          abi: parseAbi(["function quoteUsd6(address asset, uint256 amount) view returns (bool ok, uint256 usd6)"]),
          functionName: "quoteUsd6",
          args: [HBAR, 100_000_000n],
        });
        hbarUsd = ok ? `$${(Number(usd6) / 1e6).toFixed(4)}` : "unavailable (stale): spending is denied until it refreshes";
      }
      const today = Math.floor(Date.now() / 86_400_000);
      const spent = s.day === today ? s.spentTodayUsd6 : 0n;
      return text({
        account: cfg.account,
        agent: cfg.agent.address,
        expiresAt: new Date(Number(s.expiresAt) * 1000).toISOString(),
        expired: Number(s.expiresAt) * 1000 <= Date.now(),
        perPaymentCap: usd(s.perCallCapUsd6),
        dailyCap: usd(s.dailyCapUsd6),
        spentToday: usd(spent),
        remainingToday: usd(s.dailyCapUsd6 > spent ? s.dailyCapUsd6 - spent : 0n),
        recipientsRestricted: s.recipientsRestricted,
        hbarUsd,
      });
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay from the account",
      description:
        "Sends HBAR, USDC or WHBAR from the account to a recipient as a sponsored session payment (the agent needs " +
        "no HBAR). The account enforces the owner's caps and recipient list; a denial returns its reason code.",
      inputSchema: {
        to: z.string().describe("Recipient Hedera account id (0.0.x) or EVM address (0x…)"),
        amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Amount in whole units, e.g. \"0.5\""),
        asset: z.enum(["HBAR", "USDC", "WHBAR"]).default("HBAR"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, amount, asset }) => {
      try {
        const recipient = await resolveRecipient(to);
        const units = parseUnits(amount, ASSETS[asset].decimals);
        const action = buildSessionAction(ACTION_IDS.payment, encodePayment({ asset: assetAddress(asset), to: recipient, amount: units }));
        const signature = await signSessionAction(cfg.agent, chainId, cfg.account, action);
        const res = await fetchImpl(`${appUrl}/api/sponsor`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toSponsorRequest.sessionAction(chainId, cfg.account, action, signature), bigintSafe),
        });
        const body = (await res.json()) as { receipt?: Record<string, unknown>; error?: string };
        if (!body.receipt) return text(`Sponsor unavailable: ${body.error ?? res.status}`, true);
        const r = body.receipt;
        const summary = {
          status: r.status,
          reasonCode: r.reasonCode ?? null,
          deniedBy: r.deniedBy ?? null,
          detail: r.detail ?? null,
          transactionId: r.transactionId ?? null,
          hashscan: r.transactionId ? hashscanTx(toMirrorTransactionId(String(r.transactionId))) : null,
          hcsAudit: r.hcsAudit ?? null,
        };
        return text(summary, r.status !== "success");
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  server.registerTool(
    "fetch_paid_resource",
    {
      title: "Fetch an x402 paid resource",
      description:
        "GETs a URL; if it answers 402 Payment Required (x402 exact / Hedera transferExecutor), pays from the " +
        "account with this agent's session key and returns the resource with the settlement transaction.",
      inputSchema: {
        url: z.string().url(),
        maxHbar: z.string().regex(/^\d+(\.\d+)?$/).default("1").describe("Refuse to pay more than this many HBAR"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, maxHbar }) => {
      try {
        const first = await fetchImpl(url, { cache: "no-store" });
        if (first.status !== 402) return text({ status: first.status, paid: false, body: await first.text() });
        const header = first.headers.get("payment-required");
        if (!header) return text("402 without a PAYMENT-REQUIRED header", true);
        let required = decodePaymentRequiredHeader(header);
        const executors = (required.accepts[0]?.extra?.executors as string[] | undefined) ?? [];
        const contract = await mirror.getContract(cfg.account);
        if (!contract) return text(`account ${cfg.account} not found on Mirror Node`, true);
        if (!executors.includes(contract.contract_id)) {
          // Ask this app's facilitator to admit the account (factory-deployed accounts only), then re-read the offer.
          const admit = await fetchImpl(`${appUrl}/api/x402/facilitator/admit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ account: cfg.account }),
          });
          if (!admit.ok) return text(`facilitator refused executor: ${await admit.text()}`, true);
          const again = await fetchImpl(url, { cache: "no-store" });
          const h = again.headers.get("payment-required");
          if (again.status !== 402 || !h) return text("resource stopped asking for payment", true);
          required = decodePaymentRequiredHeader(h);
        }
        const client = new x402Client()
          .register(
            X402_HEDERA_TESTNET,
            new TransferExecutorClient({ signer: cfg.agent, chainId, account: cfg.account, accountId: contract.contract_id, mirror }),
          )
          .setSpendControls(x402HbarSpendControls(cfg.maxX402Tinybars ?? parseUnits(maxHbar, 8)));
        const payload = await client.createPaymentPayload(required);
        const paid = await fetchImpl(url, {
          cache: "no-store",
          headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
        });
        const ph = paid.headers.get("payment-response");
        const settlement = ph ? decodePaymentResponseHeader(ph) : null;
        const body = await paid.text();
        return text(
          {
            status: paid.status,
            paid: settlement?.success === true,
            settlement,
            hashscan: settlement?.transaction ? hashscanTx(toMirrorTransactionId(settlement.transaction)) : null,
            body: safeJson(body),
          },
          paid.status !== 200,
        );
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Get policy audit log",
      description: "Recent allow/deny decisions for this account from the public HCS audit topic, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const topic = testnetDeployment.auditTopicId;
      if (!topic) return text("No HCS audit topic in this deployment.", true);
      const messages = await mirror.getTopicMessages(topic, 100);
      const mine = messages
        .map(m => ({ seq: m.sequence_number, at: m.consensus_timestamp, record: safeJson(Buffer.from(m.message, "base64").toString()) }))
        .filter(m => {
          const acct = (m.record as { account?: string } | null)?.account;
          return typeof acct === "string" && acct.toLowerCase() === cfg.account.toLowerCase();
        })
        .slice(-limit)
        .reverse();
      return text({ topic, entries: mine });
    },
  );

  return server;
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
