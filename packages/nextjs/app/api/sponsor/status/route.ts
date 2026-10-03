import { NextResponse } from "next/server";
import { MirrorClient, testnetDeployment } from "@sh/sdk";
import { getSponsor } from "~~/services/consumer/sponsorServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sponsor dashboard data. Balance and audit messages come from Mirror Node; spend counters are local metrics. */
export async function GET() {
  const s = getSponsor();
  if (!s.ok) {
    return NextResponse.json({ configured: false, missing: s.missing, deployment: testnetDeployment });
  }
  const { cfg, store } = s.sponsor;
  const mirror = new MirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });
  const [balance, audit] = await Promise.all([
    mirror.getHbarBalance(cfg.SPONSOR_ACCOUNT_ID),
    cfg.HCS_AUDIT_TOPIC_ID ? mirror.getTopicMessages(cfg.HCS_AUDIT_TOPIC_ID, 20).catch(() => []) : Promise.resolve([]),
  ]);
  return NextResponse.json({
    configured: true,
    deployment: testnetDeployment,
    network: {
      sponsorAccountId: cfg.SPONSOR_ACCOUNT_ID,
      balanceTinybars: balance.tinybars.toString(),
      auditTopicId: cfg.HCS_AUDIT_TOPIC_ID ?? null,
      auditMessages: audit.map(m => ({
        sequenceNumber: m.sequence_number,
        consensusTimestamp: m.consensus_timestamp,
        record: (() => {
          try {
            return JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
          } catch {
            return null;
          }
        })(),
      })),
    },
    local: {
      day: store.spend.day,
      spentTodayTinybars: store.spend.totalTinybars.toString(),
      perUser: Object.fromEntries([...store.spend.perUserTinybars].map(([k, v]) => [k, v.toString()])),
      dailyBudgetTinybars: cfg.SPONSOR_DAILY_BUDGET_HBAR.toString(),
      perUserDailyTinybars: cfg.SPONSOR_PER_USER_DAILY_HBAR.toString(),
      receipts: store.recentReceipts(),
    },
  });
}
