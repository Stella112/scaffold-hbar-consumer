import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HEDERA_TESTNET, MirrorClient, requireDeployment } from "@sh/sdk";
import { HcsAuditor } from "./audit";
import { type RelayerConfig, normalizeKey } from "./config";
import { Sponsor } from "./sponsor";
import { RelayerStore } from "./store";

export const hederaTestnetChain = (rpcUrl: string) =>
  defineChain({
    id: HEDERA_TESTNET.chainId,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "HashScan", url: HEDERA_TESTNET.hashscan } },
    // viem's EIP-1559 estimate can come out far below the relay's minimum ("Gas price '99' is below configured
    // minimum"). Hedera charges its own network gas price, so always quote eth_gasPrice for both fields.
    fees: {
      async estimateFeesPerGas({ client, type }) {
        const gasPrice = BigInt(await client.request({ method: "eth_gasPrice" }));
        return type === "legacy" ? { gasPrice } : { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
      },
    },
  });

/** Wires a testnet Sponsor from validated configuration and the public deployment artifact. */
export function createTestnetSponsor(cfg: RelayerConfig, dataDir: string | null = cfg.RELAYER_DATA_DIR) {
  const chain = hederaTestnetChain(cfg.HEDERA_RPC_URL);
  const key = normalizeKey(cfg.SPONSOR_PRIVATE_KEY);
  const sponsorAccount = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: http(cfg.HEDERA_RPC_URL) });
  const walletClient = createWalletClient({ chain, transport: http(cfg.HEDERA_RPC_URL), account: sponsorAccount });
  const auditor = cfg.HCS_AUDIT_TOPIC_ID ? new HcsAuditor(cfg.HCS_AUDIT_TOPIC_ID, cfg.SPONSOR_ACCOUNT_ID, key) : null;
  const store = new RelayerStore(dataDir);
  const sponsor = new Sponsor({
    publicClient,
    walletClient,
    chainId: chain.id,
    factory: requireDeployment("factory"),
    sponsorAccountId: cfg.SPONSOR_ACCOUNT_ID,
    limits: {
      dailyBudgetTinybars: cfg.SPONSOR_DAILY_BUDGET_HBAR,
      perUserDailyTinybars: cfg.SPONSOR_PER_USER_DAILY_HBAR,
      ratePerMinute: cfg.SPONSOR_RATE_LIMIT_PER_MINUTE,
    },
    store,
    mirror: new MirrorClient({ baseUrl: cfg.MIRROR_NODE_URL }),
    auditor,
  });
  return { sponsor, store, publicClient, sponsorAddress: sponsorAccount.address, auditor };
}
