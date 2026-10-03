import { type Address, getAddress, isAddress } from "viem";

/** Network constants verified on 2026-10-03 (docs/SOURCES.md). */
export const HEDERA_TESTNET = {
  name: "testnet",
  chainId: 296,
  rpcUrl: "https://testnet.hashio.io/api",
  mirrorUrl: "https://testnet.mirrornode.hedera.com/api/v1",
  hashscan: "https://hashscan.io/testnet",
  caip2: "hedera:testnet",
} as const;

export type HederaNetwork = typeof HEDERA_TESTNET;

/** 1 HBAR = 10^8 tinybars. Inside the Hedera EVM, native value and balances are tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000n;
/** JSON-RPC relays expose balances/values in weibars (18 decimals): 1 tinybar = 10^10 weibar. */
export const WEIBARS_PER_TINYBAR = 10_000_000_000n;

export const tinybarsToWeibars = (tinybars: bigint): bigint => tinybars * WEIBARS_PER_TINYBAR;
export const weibarsToTinybars = (weibars: bigint): bigint => weibars / WEIBARS_PER_TINYBAR;

const ENTITY_ID = /^(\d+)\.(\d+)\.(\d+)$/;

export const isEntityId = (value: string): boolean => ENTITY_ID.test(value);

/** `0.0.1234` → long-zero EVM address. Only valid for entities without an EVM alias (tokens, contracts). */
export function entityIdToLongZero(id: string): Address {
  const m = ENTITY_ID.exec(id);
  if (!m) throw new Error(`not a Hedera entity id: ${id}`);
  const [, shard, realm, num] = m;
  if (shard !== "0" || realm !== "0") throw new Error(`only shard 0 / realm 0 supported: ${id}`);
  return getAddress(`0x${BigInt(num!).toString(16).padStart(40, "0")}`);
}

/** Long-zero address → `0.0.N`, or null for non-long-zero (alias) addresses. */
export function longZeroToEntityId(address: Address): string | null {
  const hex = address.toLowerCase().slice(2);
  if (!hex.startsWith("000000000000000000000000")) return null;
  return `0.0.${BigInt(`0x${hex}`).toString()}`;
}

export function toAddress(value: string): Address {
  if (isEntityId(value)) return entityIdToLongZero(value);
  if (isAddress(value)) return getAddress(value);
  throw new Error(`not an EVM address or Hedera entity id: ${value}`);
}

export const hashscanTx = (txId: string, network: HederaNetwork = HEDERA_TESTNET): string =>
  `${network.hashscan}/transaction/${txId}`;

export const hashscanContract = (idOrAddress: string, network: HederaNetwork = HEDERA_TESTNET): string =>
  `${network.hashscan}/contract/${idOrAddress}`;
