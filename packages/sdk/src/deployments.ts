import type { Address } from "viem";
import testnet from "../deployments/testnet.json";

/**
 * Public deployment artifact written by `yarn bootstrap`. Contains only addresses and IDs observed on the network,
 * never secrets. Fields are absent until bootstrap has run against your operator account.
 */
export type Deployment = {
  network: "testnet";
  chainId: number;
  updatedAt: string | null;
  factory?: Address;
  factoryContractId?: string;
  /** ConsumerAccount implementation behind every EIP-1167 account clone. */
  accountImplementation?: { address: Address; contractId?: string };
  /** keccak256 of factory + implementation creation bytecode deployed; bootstrap redeploys when it changes. */
  factoryCodeHash?: string;
  auditTopicId?: string;
  tokens?: Record<string, { tokenId: string; address: Address; decimals: number; symbol: string; label?: string }>;
  saucerswap?: { router: Address; quoter: Address; whbar: Address };
  oracle?: { address: Address; kind: string; label: string; contractId?: string };
  /** ERC-4626 savings vaults by asset symbol. */
  vaults?: Record<string, { address: Address; contractId?: string; asset: Address }>;
  launchpad?: { address: Address; contractId?: string; codeHash?: string };
};

export const testnetDeployment = testnet as Deployment;

export function requireDeployment<K extends keyof Deployment>(key: K): NonNullable<Deployment[K]> {
  const v = testnetDeployment[key];
  if (v === undefined || v === null) {
    throw new Error(`deployments/testnet.json has no "${String(key)}"; run \`yarn bootstrap\` first`);
  }
  return v as NonNullable<Deployment[K]>;
}
