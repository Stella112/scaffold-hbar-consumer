import { type Address, type Hex, type PublicClient, encodeFunctionData } from "viem";
import { consumerAccountAbi, consumerAccountFactoryAbi } from "./abi";
import type { Call, OwnerIntent, SessionAction } from "./intent";

export type SessionConfig = {
  key: Address;
  expiresAt: bigint;
  perCallCapUsd6: bigint;
  dailyCapUsd6: bigint;
  allowedActions: Hex[];
  /** Empty array = any recipient. */
  allowedRecipients: Address[];
};

export type SessionState = {
  expiresAt: bigint;
  epoch: bigint;
  ownerEpoch: bigint;
  day: number;
  recipientsRestricted: boolean;
  perCallCapUsd6: bigint;
  dailyCapUsd6: bigint;
  spentTodayUsd6: bigint;
};

/** Self-call builders. Wrap the result in an owner intent: only the account itself may call these. */
export const selfCall = {
  grantSession: (account: Address, cfg: SessionConfig): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "grantSession", args: [cfg] }),
  }),
  revokeSession: (account: Address, key: Address): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "revokeSession", args: [key] }),
  }),
  associateToken: (account: Address, token: Address): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "associateToken", args: [token] }),
  }),
  setSwapRouter: (account: Address, router: Address, allowed: boolean): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "setSwapRouter", args: [router, allowed] }),
  }),
  /** Lets sessions deposit into an ERC-4626 vault; its shares stay non-transferable for sessions forever. */
  setVault: (account: Address, vault: Address, allowed: boolean): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "setVault", args: [vault, allowed] }),
  }),
  setOracle: (account: Address, oracle: Address): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "setOracle", args: [oracle] }),
  }),
  setGuardians: (account: Address, guardians: Address[], threshold: number, delaySeconds: bigint): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({
      abi: consumerAccountAbi,
      functionName: "setGuardians",
      args: [guardians, threshold, delaySeconds],
    }),
  }),
  cancelRecovery: (account: Address): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "cancelRecovery", args: [] }),
  }),
  /** Recurring payment executed by the Hedera Schedule Service; the account pays the scheduled fees in HBAR. */
  createSubscription: (account: Address, s: SubscriptionConfig): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({
      abi: consumerAccountAbi,
      functionName: "createSubscription",
      args: [s.asset, s.to, s.amount, s.intervalSeconds, s.firstAt, s.count, s.gasLimit ?? DEFAULT_SUBSCRIPTION_GAS],
    }),
  }),
  cancelSubscription: (account: Address, id: bigint): Call => ({
    target: account,
    value: 0n,
    data: encodeFunctionData({ abi: consumerAccountAbi, functionName: "cancelSubscription", args: [id] }),
  }),
};

/**
 * Gas for each scheduled execution: the payment plus scheduling the next instalment. HSS `scheduleCall` costs a flat
 * ~1.54M gas on testnet regardless of the scheduled gas limit (measured 2026-10-03), so 2M leaves headroom.
 */
export const DEFAULT_SUBSCRIPTION_GAS = 2_000_000;

export type SubscriptionConfig = {
  /** HBAR (address(0), amount in tinybars) or an HTS token EVM address. */
  asset: Address;
  to: Address;
  amount: bigint;
  intervalSeconds: bigint;
  /** Unix seconds of the first payment; must be in the future. */
  firstAt: bigint;
  count: number;
  gasLimit?: number;
};

export type SubscriptionState = {
  id: bigint;
  asset: Address;
  to: Address;
  amount: bigint;
  interval: bigint;
  nextAt: bigint;
  remaining: number;
  gasLimit: number;
  schedule: Address;
};

export const encodeExecuteOwnerIntent = (intent: OwnerIntent, signature: Hex): Hex =>
  encodeFunctionData({ abi: consumerAccountAbi, functionName: "executeOwnerIntent", args: [intent, signature] });

export const encodeExecuteSessionAction = (action: SessionAction, signature: Hex): Hex =>
  encodeFunctionData({ abi: consumerAccountAbi, functionName: "executeSessionAction", args: [action, signature] });

export const encodeCreateAccount = (owner: Address, salt: Hex): Hex =>
  encodeFunctionData({ abi: consumerAccountFactoryAbi, functionName: "createAccount", args: [owner, salt] });

/** Read-only view over a deployed ConsumerAccount. */
export class ConsumerAccountReader {
  constructor(
    readonly client: PublicClient,
    readonly address: Address,
  ) {}

  owner(): Promise<Address> {
    return this.client.readContract({ address: this.address, abi: consumerAccountAbi, functionName: "owner" });
  }

  nonceUsed(nonce: bigint): Promise<boolean> {
    return this.client.readContract({
      address: this.address,
      abi: consumerAccountAbi,
      functionName: "nonceUsed",
      args: [nonce],
    });
  }

  async session(key: Address): Promise<SessionState> {
    const s = await this.client.readContract({
      address: this.address,
      abi: consumerAccountAbi,
      functionName: "getSession",
      args: [key],
    });
    return {
      expiresAt: BigInt(s.expiresAt),
      epoch: BigInt(s.epoch),
      ownerEpoch: BigInt(s.ownerEpoch),
      day: Number(s.day),
      recipientsRestricted: s.recipientsRestricted,
      perCallCapUsd6: s.perCallCapUsd6,
      dailyCapUsd6: s.dailyCapUsd6,
      spentTodayUsd6: s.spentTodayUsd6,
    };
  }

  async subscriptions(): Promise<SubscriptionState[]> {
    const count = await this.client.readContract({
      address: this.address,
      abi: consumerAccountAbi,
      functionName: "subscriptionCount",
    });
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
    return Promise.all(
      ids.map(async id => {
        const [asset, to, amount, interval, nextAt, remaining, gasLimit, schedule] = await this.client.readContract({
          address: this.address,
          abi: consumerAccountAbi,
          functionName: "subscriptions",
          args: [id],
        });
        return { id, asset, to, amount, interval: BigInt(interval), nextAt: BigInt(nextAt), remaining, gasLimit, schedule };
      }),
    );
  }

  isSessionActionAllowed(key: Address, actionId: Hex): Promise<boolean> {
    return this.client.readContract({
      address: this.address,
      abi: consumerAccountAbi,
      functionName: "isSessionActionAllowed",
      args: [key, actionId],
    });
  }

  swapRouterAllowed(router: Address): Promise<boolean> {
    return this.client.readContract({
      address: this.address,
      abi: consumerAccountAbi,
      functionName: "swapRouterAllowed",
      args: [router],
    });
  }
}

export const predictAccountAddress = (client: PublicClient, factory: Address, owner: Address, salt: Hex) =>
  client.readContract({ address: factory, abi: consumerAccountFactoryAbi, functionName: "getAddress", args: [owner, salt] });
