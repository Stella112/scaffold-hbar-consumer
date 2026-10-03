import { HBAR, testnetDeployment } from "@sh/sdk";
import type { Address } from "viem";

export type Asset = { symbol: string; address: Address; decimals: number; label?: string };

/** HBAR plus the demo tokens recorded by bootstrap (verified IDs; see docs/SOURCES.md). */
export function assets(): Asset[] {
  return [
    { symbol: "HBAR", address: HBAR, decimals: 8 },
    ...Object.values(testnetDeployment.tokens ?? {}).map(t => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      label: t.label,
    })),
  ];
}

export const assetByAddress = (a: string) => assets().find(x => x.address.toLowerCase() === a.toLowerCase());
