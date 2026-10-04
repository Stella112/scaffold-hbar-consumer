import { type Hex, decodeAbiParameters, encodeAbiParameters, keccak256, toBytes } from "viem";

/** Typed action `consumer.action.launchpad-buy.v1` (module: contracts/actions/LaunchpadBuyAction.sol). */
export const LAUNCHPAD_BUY_ACTION_ID: Hex = keccak256(toBytes("consumer.action.launchpad-buy.v1"));

export type LaunchpadBuyInput = { launchId: bigint; amount: bigint; maxCostTinybars: bigint };

const params = [
  { type: "uint256", name: "launchId" },
  { type: "uint64", name: "amount" },
  { type: "uint256", name: "maxCostTinybars" },
] as const;

export const encodeLaunchpadBuy = (i: LaunchpadBuyInput): Hex =>
  encodeAbiParameters(params, [i.launchId, i.amount, i.maxCostTinybars]);

export const decodeLaunchpadBuy = (data: Hex): LaunchpadBuyInput => {
  const [launchId, amount, maxCostTinybars] = decodeAbiParameters(params, data);
  return { launchId, amount, maxCostTinybars };
};
