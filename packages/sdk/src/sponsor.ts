import { z } from "zod";
import type { OwnerIntent, SessionAction } from "./intent";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "hex string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address");
const uint = z.string().regex(/^\d+$/, "decimal integer string");

/** Wire format for sponsor relayer requests. bigints travel as decimal strings. */
export const sponsorRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create-account"),
    chainId: z.number().int(),
    owner: address,
    salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "32-byte hex salt"),
  }),
  z.object({
    kind: z.literal("owner-intent"),
    chainId: z.number().int(),
    account: address,
    intent: z.object({
      calls: z.array(z.object({ target: address, value: uint, data: hex })).min(1).max(16),
      nonce: uint,
      validUntil: uint,
    }),
    signature: hex,
  }),
  z.object({
    kind: z.literal("session-action"),
    chainId: z.number().int(),
    account: address,
    action: z.object({ actionId: hex, actionData: hex, nonce: uint, validUntil: uint }),
    signature: hex,
  }),
]);

export type SponsorRequest = z.infer<typeof sponsorRequestSchema>;

export type SponsorStatus = {
  sponsorAccountId: string;
  sponsorEvmAddress: string;
  balanceTinybars: string;
  dailyBudgetTinybars: string;
  spentTodayTinybars: string;
  perUserDailyTinybars: string;
  network: string;
  chainId: number;
};

const str = (v: bigint) => v.toString();

/** Serialisers from SDK types to the wire format (bigint → string). */
export const toSponsorRequest = {
  createAccount: (chainId: number, owner: `0x${string}`, salt: `0x${string}`): SponsorRequest => ({
    kind: "create-account",
    chainId,
    owner,
    salt,
  }),
  ownerIntent: (chainId: number, account: `0x${string}`, intent: OwnerIntent, signature: `0x${string}`): SponsorRequest => ({
    kind: "owner-intent",
    chainId,
    account,
    intent: {
      calls: intent.calls.map(c => ({ target: c.target, value: str(c.value), data: c.data })),
      nonce: str(intent.nonce),
      validUntil: str(intent.validUntil),
    },
    signature,
  }),
  sessionAction: (
    chainId: number,
    account: `0x${string}`,
    action: SessionAction,
    signature: `0x${string}`,
  ): SponsorRequest => ({
    kind: "session-action",
    chainId,
    account,
    action: {
      actionId: action.actionId,
      actionData: action.actionData,
      nonce: str(action.nonce),
      validUntil: str(action.validUntil),
    },
    signature,
  }),
};
