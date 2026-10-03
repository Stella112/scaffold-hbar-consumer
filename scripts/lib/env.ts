import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ENV_FILE = path.join(ROOT, ".env");

loadDotenv({ path: ENV_FILE, quiet: true });

const accountId = z.string().regex(/^0\.0\.\d+$/, "Hedera account id 0.0.x");
const ecdsaKey = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "32-byte ECDSA private key hex");

export const operatorEnv = z.object({
  HEDERA_OPERATOR_ID: accountId,
  HEDERA_OPERATOR_KEY: ecdsaKey,
});

/** Role keys. Controller and agent keys never need a Hedera account: they only sign. */
export const roleEnv = z.object({
  SPONSOR_ACCOUNT_ID: accountId,
  SPONSOR_PRIVATE_KEY: ecdsaKey,
  CONTROLLER_PRIVATE_KEY: ecdsaKey,
  AGENT_PRIVATE_KEY: ecdsaKey,
  MERCHANT_ACCOUNT_ID: accountId,
  MERCHANT_PRIVATE_KEY: ecdsaKey,
  UNASSOCIATED_ACCOUNT_ID: accountId,
  UNASSOCIATED_PRIVATE_KEY: ecdsaKey,
});

export type RoleEnv = z.infer<typeof roleEnv>;

export const hex0x = (k: string): `0x${string}` => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

/** Reports which variables are missing/invalid without echoing any value. */
export function parseEnv<T extends z.ZodTypeAny>(schema: T, label: string): z.infer<T> {
  const r = schema.safeParse(process.env);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map(i => String(i.path[0])))].join(", ");
    throw new Error(`${label}: missing or invalid ${fields} in .env (see .env.example)`);
  }
  return r.data;
}

/** Appends variables to .env (local, gitignored). Never prints values. */
export function appendEnv(vars: Record<string, string>): void {
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = Object.entries(vars)
    .filter(([k]) => !new RegExp(`^${k}=`, "m").test(existing))
    .map(([k, v]) => `${k}=${v}`);
  if (lines.length === 0) return;
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(ENV_FILE, `${existing}${sep}${lines.join("\n")}\n`);
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
