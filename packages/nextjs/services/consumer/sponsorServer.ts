import { type RelayerConfig, createTestnetSponsor, relayerEnvSchema } from "@sh/relayer";

/**
 * Server-only sponsor singleton for Next.js API routes. Imports @hiero-ledger/sdk and reads private keys:
 * never import this module from a client component.
 */
type Instance = ReturnType<typeof createTestnetSponsor> & { cfg: RelayerConfig };

let instance: Instance | null = null;

export type SponsorAvailability = { ok: true; sponsor: Instance } | { ok: false; missing: string[] };

export function getSponsor(): SponsorAvailability {
  if (instance) return { ok: true, sponsor: instance };
  const parsed = relayerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    return { ok: false, missing: [...new Set(parsed.error.issues.map(i => String(i.path[0])))] };
  }
  try {
    // Serverless hosts only allow writes under /tmp.
    const dataDir = process.env.VERCEL ? "/tmp/relayer" : parsed.data.RELAYER_DATA_DIR;
    instance = { ...createTestnetSponsor(parsed.data, dataDir), cfg: parsed.data };
    return { ok: true, sponsor: instance };
  } catch (e) {
    return { ok: false, missing: [(e as Error).message] };
  }
}
