import type { Address, Hex } from "viem";
import { HEDERA_TESTNET } from "./hedera";

/** Response shapes for the Mirror Node fields this SDK reads (verified against testnet 2026-10-03). */
export type MirrorContractResult = {
  hash: Hex;
  result: string;
  status: string;
  error_message: string | null;
  timestamp: string;
  contract_id: string | null;
  from: Address;
  to: Address | null;
  gas_used: number | null;
  created_contract_ids: string[];
  logs: { address: Address; topics: Hex[]; data: Hex; contract_id: string }[];
};

export type MirrorTransaction = {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;
  charged_tx_fee: number;
  transfers: { account: string; amount: number; is_approval: boolean }[];
  token_transfers: { token_id: string; account: string; amount: number; is_approval: boolean }[];
};

export type MirrorAccount = {
  account: string;
  evm_address: Address | null;
  balance: { balance: number; timestamp: string; tokens: { token_id: string; balance: number }[] };
  max_automatic_token_associations: number;
};

export type MirrorAirdrop = {
  amount: number;
  receiver_id: string;
  sender_id: string;
  token_id: string;
  serial_number: number | null;
  timestamp: { from: string; to: string | null };
};

export class MirrorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type MirrorClientOptions = { baseUrl?: string; fetchImpl?: typeof fetch };

export class MirrorClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MirrorClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? HEDERA_TESTNET.mirrorUrl).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new MirrorError(`mirror ${path} -> HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** Returns null when the account does not exist (e.g. a controller key that never touched the ledger). */
  async getAccount(idOrEvmAddress: string): Promise<MirrorAccount | null> {
    try {
      return await this.get<MirrorAccount>(`/accounts/${idOrEvmAddress}?transactions=false`);
    } catch (e) {
      if (e instanceof MirrorError && e.status === 404) return null;
      throw e;
    }
  }

  /** Tinybar balance; 0 for accounts that do not exist on the ledger. */
  async getHbarBalance(idOrEvmAddress: string): Promise<{ tinybars: bigint; exists: boolean }> {
    const acct = await this.getAccount(idOrEvmAddress);
    return { tinybars: BigInt(acct?.balance.balance ?? 0), exists: acct !== null };
  }

  async getTokenBalance(idOrEvmAddress: string, tokenId: string): Promise<bigint | null> {
    const acct = await this.getAccount(idOrEvmAddress);
    if (!acct) return null;
    const row = acct.balance.tokens.find(t => t.token_id === tokenId);
    return row ? BigInt(row.balance) : null;
  }

  async isAssociated(idOrEvmAddress: string, tokenId: string): Promise<boolean> {
    const res = await this.get<{ tokens: { token_id: string }[] }>(
      `/accounts/${idOrEvmAddress}/tokens?token.id=${tokenId}&limit=1`,
    );
    return res.tokens.some(t => t.token_id === tokenId);
  }

  async getContractResult(txHash: Hex): Promise<MirrorContractResult | null> {
    try {
      return await this.get<MirrorContractResult>(`/contracts/results/${txHash}`);
    } catch (e) {
      if (e instanceof MirrorError && e.status === 404) return null;
      throw e;
    }
  }

  /** Mirror Node lags consensus by a few seconds; poll until the result is indexed. */
  async waitForContractResult(txHash: Hex, timeoutMs = 60_000, intervalMs = 2_000): Promise<MirrorContractResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.getContractResult(txHash);
      if (r) return r;
      if (Date.now() > deadline) throw new MirrorError(`mirror did not index ${txHash} within ${timeoutMs}ms`, 404);
      await new Promise(res => setTimeout(res, intervalMs));
    }
  }

  async getTransaction(transactionId: string): Promise<MirrorTransaction | null> {
    try {
      const res = await this.get<{ transactions: MirrorTransaction[] }>(`/transactions/${transactionId}`);
      return res.transactions[0] ?? null;
    } catch (e) {
      if (e instanceof MirrorError && e.status === 404) return null;
      throw e;
    }
  }

  async getPendingAirdrops(receiverId: string): Promise<MirrorAirdrop[]> {
    return (await this.get<{ airdrops: MirrorAirdrop[] }>(`/accounts/${receiverId}/airdrops/pending`)).airdrops;
  }

  async getOutstandingAirdrops(senderId: string): Promise<MirrorAirdrop[]> {
    return (await this.get<{ airdrops: MirrorAirdrop[] }>(`/accounts/${senderId}/airdrops/outstanding`)).airdrops;
  }

  async getTopicMessages(topicId: string, limit = 25): Promise<{ sequence_number: number; message: string; consensus_timestamp: string }[]> {
    const res = await this.get<{ messages: { sequence_number: number; message: string; consensus_timestamp: string }[] }>(
      `/topics/${topicId}/messages?limit=${limit}&order=desc`,
    );
    return res.messages;
  }
}

/** Mirror transaction ids use `0.0.x-seconds-nanos`; SDK/HashScan use `0.0.x@seconds.nanos`. */
export function toMirrorTxId(txId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : txId;
}
