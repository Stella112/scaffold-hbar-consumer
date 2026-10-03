import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "hex string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address");
const uint = z.string().regex(/^\d+$/, "decimal integer string");

/** Wire format for sponsor relayer requests. bigints travel as decimal strings. */
export const sponsorRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create-account"),
    chainId: z.number().int(),
    owner: address,
    salt: hex,
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
