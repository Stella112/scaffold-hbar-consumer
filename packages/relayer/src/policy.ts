import type { SponsorDenialCode } from "@sh/sdk";

/**
 * Off-chain sponsor policy. It protects the sponsor's HBAR only; user assets are protected by the
 * ConsumerAccount contract, which re-checks every authorization on-chain.
 */
export type SponsorLimits = {
  dailyBudgetTinybars: bigint;
  perUserDailyTinybars: bigint;
  ratePerMinute: number;
};

export type SpendState = {
  day: string;
  totalTinybars: bigint;
  perUserTinybars: Map<string, bigint>;
  recentRequests: Map<string, number[]>;
};

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export const emptySpendState = (now: number): SpendState => ({
  day: utcDay(now),
  totalTinybars: 0n,
  perUserTinybars: new Map(),
  recentRequests: new Map(),
});

/** Resets daily counters when the UTC day changes. */
export function rollDay(state: SpendState, now: number): SpendState {
  const day = utcDay(now);
  return state.day === day ? state : { ...emptySpendState(now), recentRequests: state.recentRequests };
}

export type PolicyDecision = { ok: true } | { ok: false; code: SponsorDenialCode; detail: string };

export function checkSponsorPolicy(
  state: SpendState,
  limits: SponsorLimits,
  user: string,
  estimatedFeeTinybars: bigint,
  now: number,
): PolicyDecision {
  const windowStart = now - 60_000;
  const recent = (state.recentRequests.get(user) ?? []).filter(t => t > windowStart);
  if (recent.length >= limits.ratePerMinute) {
    return { ok: false, code: "SPONSOR_RATE_LIMITED", detail: `more than ${limits.ratePerMinute} requests/minute` };
  }
  if (state.totalTinybars + estimatedFeeTinybars > limits.dailyBudgetTinybars) {
    return { ok: false, code: "SPONSOR_BUDGET_EXCEEDED", detail: "sponsor daily budget exhausted" };
  }
  const userSpent = state.perUserTinybars.get(user) ?? 0n;
  if (userSpent + estimatedFeeTinybars > limits.perUserDailyTinybars) {
    return { ok: false, code: "SPONSOR_USER_BUDGET_EXCEEDED", detail: "per-user daily sponsorship exhausted" };
  }
  return { ok: true };
}

export function recordRequest(state: SpendState, user: string, now: number): void {
  const windowStart = now - 60_000;
  const recent = (state.recentRequests.get(user) ?? []).filter(t => t > windowStart);
  recent.push(now);
  state.recentRequests.set(user, recent);
}

export function recordSpend(state: SpendState, user: string, feeTinybars: bigint): void {
  state.totalTinybars += feeTinybars;
  state.perUserTinybars.set(user, (state.perUserTinybars.get(user) ?? 0n) + feeTinybars);
}
