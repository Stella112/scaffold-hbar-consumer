import { describe, expect, it } from "vitest";
import { checkSponsorPolicy, emptySpendState, recordRequest, recordSpend, rollDay } from "../src/policy";
import { relayerEnvSchema } from "../src/config";

const limits = { dailyBudgetTinybars: 1_000n, perUserDailyTinybars: 300n, ratePerMinute: 3 };
const t0 = Date.UTC(2026, 9, 3, 12);

describe("sponsor policy", () => {
  it("allows within budget", () => {
    expect(checkSponsorPolicy(emptySpendState(t0), limits, "a", 100n, t0)).toEqual({ ok: true });
  });

  it("enforces the per-user budget", () => {
    const s = emptySpendState(t0);
    recordSpend(s, "a", 250n);
    const d = checkSponsorPolicy(s, limits, "a", 100n, t0);
    expect(d.ok === false && d.code).toBe("SPONSOR_USER_BUDGET_EXCEEDED");
    expect(checkSponsorPolicy(s, limits, "b", 100n, t0).ok).toBe(true);
  });

  it("enforces the global budget", () => {
    const s = emptySpendState(t0);
    for (const u of ["a", "b", "c"]) recordSpend(s, u, 300n);
    const d = checkSponsorPolicy(s, limits, "d", 200n, t0);
    expect(d.ok === false && d.code).toBe("SPONSOR_BUDGET_EXCEEDED");
  });

  it("rate limits per user within a minute window", () => {
    const s = emptySpendState(t0);
    for (let i = 0; i < 3; i++) recordRequest(s, "a", t0 + i);
    const d = checkSponsorPolicy(s, limits, "a", 1n, t0 + 10);
    expect(d.ok === false && d.code).toBe("SPONSOR_RATE_LIMITED");
    expect(checkSponsorPolicy(s, limits, "a", 1n, t0 + 61_000).ok).toBe(true);
  });

  it("resets spend at the UTC day boundary", () => {
    const s = emptySpendState(t0);
    recordSpend(s, "a", 300n);
    const next = rollDay(s, t0 + 24 * 3600 * 1000);
    expect(next.totalTinybars).toBe(0n);
    expect(checkSponsorPolicy(next, limits, "a", 100n, t0 + 24 * 3600 * 1000).ok).toBe(true);
  });
});

describe("relayer config", () => {
  it("parses HBAR budgets into tinybars and never accepts malformed keys", () => {
    const ok = relayerEnvSchema.parse({
      SPONSOR_ACCOUNT_ID: "0.0.1234",
      SPONSOR_PRIVATE_KEY: "0x" + "11".repeat(32),
      SPONSOR_DAILY_BUDGET_HBAR: "2.5",
    });
    expect(ok.SPONSOR_DAILY_BUDGET_HBAR).toBe(250_000_000n);
    expect(relayerEnvSchema.safeParse({ SPONSOR_ACCOUNT_ID: "0.0.1", SPONSOR_PRIVATE_KEY: "nope" }).success).toBe(false);
  });
});
