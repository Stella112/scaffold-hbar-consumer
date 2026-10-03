import { z } from "zod";
import { HEDERA_TESTNET, TINYBARS_PER_HBAR } from "@sh/sdk";

const hbarToTinybars = (v: string) => {
  const [whole = "0", frac = ""] = v.split(".");
  return BigInt(whole) * TINYBARS_PER_HBAR + BigInt((frac + "00000000").slice(0, 8));
};

const hbar = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, "HBAR amount like 25 or 0.5")
  .transform(hbarToTinybars);

/** Server-only configuration. Never import this from browser code. */
export const relayerEnvSchema = z.object({
  HEDERA_NETWORK: z.literal("testnet").default("testnet"),
  HEDERA_RPC_URL: z.string().url().default(HEDERA_TESTNET.rpcUrl),
  MIRROR_NODE_URL: z.string().url().default(HEDERA_TESTNET.mirrorUrl),
  SPONSOR_ACCOUNT_ID: z.string().regex(/^0\.0\.\d+$/, "Hedera account id 0.0.x"),
  SPONSOR_PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "32-byte ECDSA private key hex"),
  SPONSOR_DAILY_BUDGET_HBAR: hbar.default(hbarToTinybars("50")),
  SPONSOR_PER_USER_DAILY_HBAR: hbar.default(hbarToTinybars("5")),
  SPONSOR_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  HCS_AUDIT_TOPIC_ID: z
    .string()
    .regex(/^0\.0\.\d+$/)
    .optional(),
  RELAYER_DATA_DIR: z.string().default(".data/relayer"),
  RELAYER_PORT: z.coerce.number().int().positive().default(4010),
});

export type RelayerConfig = z.infer<typeof relayerEnvSchema>;

export function loadRelayerConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const parsed = relayerEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values.
    const fields = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid relayer environment: ${fields}`);
  }
  return parsed.data;
}

export const normalizeKey = (k: string): `0x${string}` => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
