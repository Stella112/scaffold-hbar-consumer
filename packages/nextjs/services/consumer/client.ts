import { HEDERA_TESTNET, type SponsorRequest } from "@sh/sdk";
import { createPublicClient, defineChain, http } from "viem";

export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET.chainId,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || HEDERA_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: "HashScan", url: HEDERA_TESTNET.hashscan } },
});

export const publicClient = createPublicClient({ chain: hederaTestnet, transport: http() });

/** Untyped JSON receipt as returned by the API (bigints are decimal strings). */
export type ReceiptJson = Record<string, unknown> & {
  status: "success" | "denied";
  action: string;
  reasonCode?: string;
  deniedBy?: string;
  detail?: string;
  transactionHash?: string | null;
  transactionId?: string | null;
  account: string;
  hcsAudit?: { topicId: string; sequenceNumber: number } | null;
  mirror?: { status: string };
};

export type SponsorResponse =
  | { receipt: ReceiptJson; auditError: string | null }
  | { error: string; missing?: string[] };

export async function sponsor(req: SponsorRequest): Promise<SponsorResponse> {
  const res = await fetch("/api/sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return (await res.json()) as SponsorResponse;
}

export const hashscanTx = (id: string) => `${HEDERA_TESTNET.hashscan}/transaction/${id}`;
