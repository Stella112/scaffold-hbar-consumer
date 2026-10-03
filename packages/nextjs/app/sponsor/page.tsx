"use client";

import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { hashscanTx } from "~~/services/consumer/client";
import { formatUnits, shortAddr } from "~~/services/consumer/format";

type Status = {
  configured: boolean;
  missing?: string[];
  network?: {
    sponsorAccountId: string;
    balanceTinybars: string;
    auditTopicId: string | null;
    auditMessages: { sequenceNumber: number; consensusTimestamp: string; record: Record<string, unknown> | null }[];
  };
  local?: {
    day: string;
    spentTodayTinybars: string;
    perUser: Record<string, string>;
    dailyBudgetTinybars: string;
    perUserDailyTinybars: string;
    receipts: Record<string, unknown>[];
  };
};

const hbar = (t: string | bigint) => `${formatUnits(BigInt(t), 8, 4)} HBAR`;
const fee = (r: Record<string, unknown>) => BigInt(String(r.networkFeeTinybars ?? "0"));

const SponsorPage: NextPage = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["sponsor-status"],
    refetchInterval: 15_000,
    queryFn: async () => (await fetch("/api/sponsor/status")).json() as Promise<Status>,
  });
  if (isLoading || !data) {
    return (
      <div className="p-10 text-center">
        <span className="loading loading-dots" />
      </div>
    );
  }
  if (!data.configured || !data.network || !data.local) {
    return (
      <div className="p-10 max-w-xl mx-auto alert alert-warning">
        Sponsor not configured. Missing: {data.missing?.join(", ")}. See .env.example and run{" "}
        <code>yarn bootstrap --fund</code>.
      </div>
    );
  }
  const n = data.network;
  const l = data.local;
  const ok = l.receipts.filter(r => r.status === "success");
  const denied = l.receipts.filter(r => r.status === "denied");
  const reasons: Record<string, number> = {};
  for (const r of denied) reasons[String(r.reasonCode)] = (reasons[String(r.reasonCode)] ?? 0) + 1;
  const byAction: Record<string, bigint> = {};
  for (const r of ok) byAction[String(r.action)] = (byAction[String(r.action)] ?? 0n) + fee(r);
  const avgFee = ok.length ? ok.reduce((a, r) => a + fee(r), 0n) / BigInt(ok.length) : 0n;
  const agentSpend = ok.filter(r => r.actorType === "session").reduce((a, r) => a + fee(r), 0n);

  return (
    <div className="px-4 py-10 max-w-5xl mx-auto w-full flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Sponsor</h1>
      <section>
        <h2 className="text-sm uppercase opacity-60 mb-2">From the network (Mirror Node)</h2>
        <div className="stats stats-vertical md:stats-horizontal shadow w-full">
          <div className="stat">
            <div className="stat-title">Sponsor balance</div>
            <div className="stat-value text-2xl">{hbar(n.balanceTinybars)}</div>
            <div className="stat-desc">{n.sponsorAccountId}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Estimated runway</div>
            <div className="stat-value text-2xl">
              {avgFee > 0n ? `${(BigInt(n.balanceTinybars) / avgFee).toLocaleString()} tx` : "—"}
            </div>
            <div className="stat-desc">at average fee {avgFee > 0n ? hbar(avgFee) : "—"}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Audit topic</div>
            <div className="stat-value text-2xl">{n.auditTopicId ?? "—"}</div>
            <div className="stat-desc">{n.auditMessages.length} recent records</div>
          </div>
        </div>
      </section>
      <section>
        <h2 className="text-sm uppercase opacity-60 mb-2">Local operational metrics (this relayer instance)</h2>
        <div className="stats stats-vertical md:stats-horizontal shadow w-full">
          <div className="stat">
            <div className="stat-title">Spent today</div>
            <div className="stat-value text-2xl">{hbar(l.spentTodayTinybars)}</div>
            <div className="stat-desc">
              budget {hbar(l.dailyBudgetTinybars)} · remaining{" "}
              {hbar(BigInt(l.dailyBudgetTinybars) - BigInt(l.spentTodayTinybars))}
            </div>
          </div>
          <div className="stat">
            <div className="stat-title">Sponsored / denied</div>
            <div className="stat-value text-2xl">
              {ok.length} / {denied.length}
            </div>
            <div className="stat-desc">recent requests</div>
          </div>
          <div className="stat">
            <div className="stat-title">Agent spending</div>
            <div className="stat-value text-2xl">{hbar(agentSpend)}</div>
            <div className="stat-desc">fees sponsored for agent actions</div>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-4 mt-4 text-sm">
          <div className="card bg-base-100 shadow-sm p-4">
            <h3 className="font-semibold mb-2">Spend per user</h3>
            {Object.entries(l.perUser).map(([u, v]) => (
              <div key={u} className="flex justify-between">
                <span>{shortAddr(u)}</span>
                <span>{hbar(v)}</span>
              </div>
            ))}
          </div>
          <div className="card bg-base-100 shadow-sm p-4">
            <h3 className="font-semibold mb-2">Spend per action</h3>
            {Object.entries(byAction).map(([a, v]) => (
              <div key={a} className="flex justify-between">
                <span>{a}</span>
                <span>{hbar(v)}</span>
              </div>
            ))}
          </div>
          <div className="card bg-base-100 shadow-sm p-4">
            <h3 className="font-semibold mb-2">Common denial reasons</h3>
            {Object.entries(reasons).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <code>{k}</code>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h2 className="text-sm uppercase opacity-60 mb-2">Latest HCS audit records</h2>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Decision</th>
                <th>By</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {n.auditMessages.map(m => (
                <tr key={m.sequenceNumber}>
                  <td>{m.sequenceNumber}</td>
                  <td>{String(m.record?.action ?? "?")}</td>
                  <td>
                    {String(m.record?.actorType ?? "")} {m.record?.actor ? shortAddr(String(m.record.actor)) : ""}
                  </td>
                  <td>
                    {m.record?.allowed ? (
                      <span className="badge badge-success badge-sm">allowed</span>
                    ) : (
                      <span className="badge badge-error badge-sm">{String(m.record?.reasonCode)}</span>
                    )}
                  </td>
                  <td>{String(m.record?.decidedBy ?? "")}</td>
                  <td>
                    {m.record?.transactionId ? (
                      <a
                        className="link"
                        href={hashscanTx(String(m.record.transactionId))}
                        target="_blank"
                        rel="noreferrer"
                      >
                        view
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default SponsorPage;
