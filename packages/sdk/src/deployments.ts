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
  auditTopicId?: string;
  tokens?: Record<string, { tokenId: string; address: Address; decimals: number; symbol: string; label?: string }>;
  saucerswap?: { router: Address; quoter: Address; whbar: Address };
  oracle?: { address: Address; kind: string; label: string; contractId?: string };
};

export const testnetDeployment = testnet as Deployment;

export function requireDeployment<K extends keyof Deployment>(key: K): NonNullable<Deployment[K]> {
  const v = testnetDeployment[key];
  if (v === undefined || v === null) {
    throw new Error(`deployments/testnet.json has no "${String(key)}"; run \`yarn bootstrap\` first`);
  }
  return v as NonNullable<Deployment[K]>;
}
