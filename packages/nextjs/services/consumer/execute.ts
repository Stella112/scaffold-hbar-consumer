import { publicClient, sponsor } from "./client";
import {
  ACTION_IDS,
  type Call,
  HBAR,
  HEDERA_TESTNET,
  MirrorClient,
  buildOwnerIntent,
  buildSessionAction,
  consumerAccountAbi,
  encodePayment,
  encodeSwapToPay,
  exactOutputPath,
  longZeroToEntityId,
  selfCall,
  signOwnerIntent,
  signSessionAction,
  testnetDeployment,
  toSponsorRequest,
} from "@sh/sdk";
import { type Address, type LocalAccount, parseAbi } from "viem";

const chainId = HEDERA_TESTNET.chainId;
const mirror = new MirrorClient({ baseUrl: process.env.NEXT_PUBLIC_MIRROR_NODE_URL || HEDERA_TESTNET.mirrorUrl });

export const ownerCalls = async (controller: LocalAccount, account: Address, calls: Call[]) => {
  const intent = buildOwnerIntent(calls);
  return sponsor(
    toSponsorRequest.ownerIntent(chainId, account, intent, await signOwnerIntent(controller, chainId, account, intent)),
  );
};

const typedAction = async (
  controller: LocalAccount,
  account: Address,
  actionId: `0x${string}`,
  data: `0x${string}`,
) => {
  const a = buildSessionAction(actionId, data);
  return sponsor(
    toSponsorRequest.sessionAction(chainId, account, a, await signSessionAction(controller, chainId, account, a)),
  );
};

export const pay = (controller: LocalAccount, account: Address, asset: Address, to: Address, amount: bigint) =>
  typedAction(controller, account, ACTION_IDS.payment, encodePayment({ asset, to, amount }));

export const airdrop = (controller: LocalAccount, account: Address, token: Address, to: Address, amount: bigint) =>
  typedAction(controller, account, ACTION_IDS.airdrop, encodePayment({ asset: token, to, amount }));

/**
 * How a token can reach a recipient: "direct" when associated, "airdrop" (HIP-904 pending/claimable) when not.
 * Decided from Mirror Node state, never by catching a failed transfer.
 */
export async function deliveryMode(recipient: Address, asset: Address): Promise<"direct" | "airdrop" | "unknown"> {
  if (asset === HBAR) return "direct";
  const tokenId = longZeroToEntityId(asset);
  if (!tokenId) return "unknown";
  const acct = await mirror.getAccount(recipient);
  if (!acct) return "unknown";
  return (await mirror.isAssociated(acct.account, tokenId)) ? "direct" : "airdrop";
}

const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

/** SaucerSwap V2 pool fee used by the demo pairs (0.30%, verified in docs/SOURCES.md). */
export const SWAP_FEE = 3000;
export const SLIPPAGE_BPS = 200n;

export async function quoteExactOutput(tokenIn: Address, tokenOut: Address, amountOut: bigint): Promise<bigint> {
  const ss = testnetDeployment.saucerswap;
  if (!ss) throw new Error("SAUCERSWAP_QUOTE_UNAVAILABLE: no SaucerSwap config in deployments");
  try {
    const r = (await publicClient.readContract({
      address: ss.quoter,
      abi: quoterAbi,
      functionName: "quoteExactOutputSingle",
      args: [{ tokenIn, tokenOut, amount: amountOut, fee: SWAP_FEE, sqrtPriceLimitX96: 0n }],
    })) as unknown as readonly [bigint];
    return r[0];
  } catch {
    throw new Error("SAUCERSWAP_QUOTE_UNAVAILABLE: no route or liquidity for this pair");
  }
}

/** Swap-to-pay: exactly `amountOut` of tokenOut reaches `to`; spends at most quote + slippage of tokenIn. */
export async function swapToPay(
  controller: LocalAccount,
  account: Address,
  p: { tokenIn: Address; tokenOut: Address; amountOut: bigint; to: Address; quotedIn: bigint },
) {
  const ss = testnetDeployment.saucerswap!;
  const allowed = await publicClient.readContract({
    address: account,
    abi: consumerAccountAbi,
    functionName: "swapRouterAllowed",
    args: [ss.router],
  });
  if (!allowed) {
    const r = await ownerCalls(controller, account, [selfCall.setSwapRouter(account, ss.router, true)]);
    if (!("receipt" in r) || r.receipt.status !== "success") return r;
  }
  return typedAction(
    controller,
    account,
    ACTION_IDS.swapToPay,
    encodeSwapToPay({
      router: ss.router,
      tokenIn: p.tokenIn,
      amountInMaximum: (p.quotedIn * (10_000n + SLIPPAGE_BPS)) / 10_000n,
      tokenOut: p.tokenOut,
      amountOut: p.amountOut,
      to: p.to,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      path: exactOutputPath([p.tokenOut, p.tokenIn], [SWAP_FEE]),
    }),
  );
}
