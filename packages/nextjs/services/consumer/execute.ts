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
  encodeVaultDeposit,
  exactOutputPath,
  longZeroToEntityId,
  selfCall,
  signOwnerIntent,
  signSessionAction,
  testnetDeployment,
  toSponsorRequest,
  tokenLaunchpadAbi,
} from "@sh/sdk";
import { type Address, type LocalAccount, encodeFunctionData, parseAbi } from "viem";

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

// ------------------------------------------------------------------ savings vault + launchpad recipes

const vaultAbi = parseAbi([
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const erc20BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** WHBAR.deposit(): wraps HBAR held by the account (associating WHBAR first if needed). */
export async function wrapHbar(controller: LocalAccount, account: Address, tinybars: bigint) {
  const ss = testnetDeployment.saucerswap!;
  const whbar = testnetDeployment.tokens!.WHBAR!;
  const calls: Call[] = [];
  if (!(await mirror.isAssociated(account, whbar.tokenId).catch(() => false))) {
    calls.push(selfCall.associateToken(account, whbar.address));
  }
  calls.push({ target: ss.whbar, value: tinybars, data: "0xd0e30db0" });
  return ownerCalls(controller, account, calls);
}

/** Typed vault-deposit (allowlisting the vault first). Shares are always minted to the account itself. */
export async function vaultDeposit(controller: LocalAccount, account: Address, vault: Address, assets: bigint) {
  const allowed = await publicClient.readContract({
    address: account,
    abi: consumerAccountAbi,
    functionName: "vaultAllowed",
    args: [vault],
  });
  if (!allowed) {
    const r = await ownerCalls(controller, account, [selfCall.setVault(account, vault, true)]);
    if (!("receipt" in r) || r.receipt.status !== "success") return r;
  }
  return typedAction(controller, account, ACTION_IDS.vaultDeposit, encodeVaultDeposit({ vault, assets }));
}

/** Owner-only: redeem shares back to the account. Sessions can never do this. */
export const vaultRedeem = (controller: LocalAccount, account: Address, vault: Address, shares: bigint) =>
  ownerCalls(controller, account, [
    {
      target: vault,
      value: 0n,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [shares, account, account] }),
    },
  ]);

export async function vaultPosition(account: Address, vault: Address, asset: Address) {
  const [shares, liquid] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: asset, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account] }),
  ]);
  const saved = shares
    ? await publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToAssets",
        args: [shares],
      })
    : 0n;
  return { shares, saved, liquid };
}

/** Launch a token from the account; `feeTinybars` covers the HTS creation fee (unspent part is refunded). */
export const launchToken = (
  controller: LocalAccount,
  account: Address,
  params: {
    name: string;
    symbol: string;
    decimals: number;
    supply: bigint;
    forSale: bigint;
    priceTinybars: bigint;
    target: bigint;
    duration: bigint;
  },
  feeTinybars: bigint,
) =>
  ownerCalls(controller, account, [
    {
      target: testnetDeployment.launchpad!.address,
      value: feeTinybars,
      data: encodeFunctionData({ abi: tokenLaunchpadAbi, functionName: "launch", args: [params] }),
    },
  ]);

/** Buy from a launch with the account's HBAR (exact quoted price). */
export async function launchBuy(controller: LocalAccount, account: Address, id: bigint, amount: bigint) {
  const pad = testnetDeployment.launchpad!.address;
  const cost = await publicClient.readContract({
    address: pad,
    abi: tokenLaunchpadAbi,
    functionName: "quote",
    args: [id, amount],
  });
  return ownerCalls(controller, account, [
    {
      target: pad,
      value: cost,
      data: encodeFunctionData({ abi: tokenLaunchpadAbi, functionName: "buy", args: [id, amount] }),
    },
  ]);
}

/** HBAR sent with a launchpad claim to cover its airdrop fee (~1 HBAR for a pending airdrop); unspent is refunded. */
export const CLAIM_FEE_TINYBARS = 200_000_000n;

/** Permissionless graduate, or claim (associating the token first, if needed, so it is delivered directly). */
export async function launchCall(
  controller: LocalAccount,
  account: Address,
  fn: "graduate" | "claim" | "refund",
  id: bigint,
  token?: Address,
) {
  const tokenId = token ? longZeroToEntityId(token) : null;
  const needsAssociation =
    fn === "claim" && token && tokenId && !(await mirror.isAssociated(account, tokenId).catch(() => false));
  return ownerCalls(controller, account, [
    ...(needsAssociation ? [selfCall.associateToken(account, token!)] : []),
    {
      target: testnetDeployment.launchpad!.address,
      // A claim's HIP-904 airdrop fee is charged to the launchpad, so send some HBAR along; the rest comes back.
      value: fn === "claim" ? CLAIM_FEE_TINYBARS : 0n,
      data: encodeFunctionData({ abi: tokenLaunchpadAbi, functionName: fn, args: [id] }),
    },
  ]);
}
