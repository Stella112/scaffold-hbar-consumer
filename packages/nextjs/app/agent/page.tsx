"use client";

import { useEffect, useState } from "react";
import { ACTION_IDS, ConsumerAccountReader, selfCall, testnetDeployment } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { type Address, getAddress, isAddress } from "viem";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import { type ReceiptJson, type SponsorResponse, publicClient } from "~~/services/consumer/client";
import { ownerCalls } from "~~/services/consumer/execute";
import { formatUnits, parseUnits } from "~~/services/consumer/format";

const SCENARIOS = [
  { id: "pay", label: "Pay within limits", expect: "allowed (priced live by the Supra oracle)" },
  { id: "x402", label: "Buy data via x402", expect: "402 → signed payment → 200 + settlement" },
  { id: "overspend", label: "Spend 1000× more", expect: "PER_CALL_CAP_EXCEEDED / PRICE_UNAVAILABLE" },
  { id: "other-recipient", label: "Pay itself", expect: "RECIPIENT_NOT_ALLOWED" },
  { id: "save", label: "Save for me", expect: "allowed: vault-deposit within limits" },
  { id: "withdraw", label: "Withdraw savings", expect: "WITHDRAW_FORBIDDEN" },
  { id: "steal-shares", label: "Move savings shares", expect: "WITHDRAW_FORBIDDEN" },
  { id: "escalate", label: "Make itself owner", expect: "PRIVILEGE_ESCALATION" },
  { id: "raw-call", label: "Arbitrary call", expect: "RAW_CALL_FORBIDDEN" },
] as const;

const AgentPage: NextPage = () => {
  const agentInfo = useQuery({
    queryKey: ["agent-info"],
    queryFn: async () =>
      (await fetch("/api/agent")).json() as Promise<{ configured: boolean; address: Address | null; kind: string }>,
  });
  const [agentAddr, setAgentAddr] = useState("");
  const [perCall, setPerCall] = useState("1");
  const [daily, setDaily] = useState("3");
  const [hours, setHours] = useState("24");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [grantResult, setGrantResult] = useState<SponsorResponse | null>(null);
  const [runs, setRuns] = useState<{ label: string; receipt: ReceiptJson; auditError: string | null }[]>([]);
  const [x402Runs, setX402Runs] = useState<X402Run[]>([]);

  useEffect(() => {
    if (agentInfo.data?.address && !agentAddr) setAgentAddr(agentInfo.data.address);
  }, [agentInfo.data, agentAddr]);

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <h1 className="text-2xl font-bold">Agent</h1>
      <AccountGate>
        {({ controller, account }) => (
          <AgentPanel
            account={account.address}
            agent={isAddress(agentAddr) ? getAddress(agentAddr) : null}
            render={session => (
              <div className="w-full max-w-2xl flex flex-col gap-4">
                <div className="card bg-base-100 shadow">
                  <div className="card-body gap-3">
                    <h2 className="font-semibold">Give an agent a limited allowance</h2>
                    <p className="text-xs opacity-70">
                      The agent can only use approved actions. Limits are enforced by your account on Hedera, not by
                      this website.
                      {agentInfo.data?.configured ? ` Demo agent: ${agentInfo.data.kind}.` : ""}
                    </p>
                    <input
                      className="input input-bordered text-xs"
                      placeholder="Agent address 0x…"
                      value={agentAddr}
                      onChange={e => setAgentAddr(e.target.value)}
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <label className="form-control">
                        <span className="label-text text-xs">Per payment (USD)</span>
                        <input
                          className="input input-bordered input-sm"
                          value={perCall}
                          onChange={e => setPerCall(e.target.value)}
                        />
                      </label>
                      <label className="form-control">
                        <span className="label-text text-xs">Per day (USD)</span>
                        <input
                          className="input input-bordered input-sm"
                          value={daily}
                          onChange={e => setDaily(e.target.value)}
                        />
                      </label>
                      <label className="form-control">
                        <span className="label-text text-xs">Expires (hours)</span>
                        <input
                          className="input input-bordered input-sm"
                          value={hours}
                          onChange={e => setHours(e.target.value)}
                        />
                      </label>
                    </div>
                    <input
                      className="input input-bordered input-sm text-xs"
                      placeholder="Only pay this recipient (optional, 0x…)"
                      value={recipient}
                      onChange={e => setRecipient(e.target.value)}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={!isAddress(agentAddr) || busy !== null}
                      onClick={async () => {
                        setBusy("grant");
                        const r = await ownerCalls(controller, account.address, [
                          selfCall.grantSession(account.address, {
                            key: getAddress(agentAddr),
                            expiresAt: BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(hours)) * 3600),
                            perCallCapUsd6: parseUnits(perCall, 6),
                            dailyCapUsd6: parseUnits(daily, 6),
                            allowedActions: [ACTION_IDS.payment, ACTION_IDS.x402Payment, ACTION_IDS.vaultDeposit],
                            allowedRecipients: isAddress(recipient) ? [getAddress(recipient)] : [],
                          }),
                        ]);
                        if ("receipt" in r) saveReceipt(r.receipt);
                        setGrantResult(r);
                        setBusy(null);
                        session.refetch();
                      }}
                    >
                      Grant allowance
                    </button>
                    {grantResult && "receipt" in grantResult ? (
                      <ReceiptCard receipt={grantResult.receipt} auditError={grantResult.auditError} />
                    ) : null}
                  </div>
                </div>

                {session.data && session.data.epoch > 0n ? (
                  <div className="card bg-base-100 shadow">
                    <div className="card-body gap-2 text-sm">
                      <h2 className="font-semibold">Active allowance</h2>
                      <div>Expires {new Date(Number(session.data.expiresAt) * 1000).toLocaleString()}</div>
                      <div>
                        ${formatUnits(session.data.perCallCapUsd6, 6)} per payment · $
                        {formatUnits(session.data.dailyCapUsd6, 6)} per day · spent today $
                        {formatUnits(session.data.spentTodayUsd6, 6)}
                      </div>
                      <div>Recipients: {session.data.recipientsRestricted ? "allowlist only" : "any"}</div>
                      {!testnetDeployment.oracle ? (
                        <div className="alert alert-warning text-xs">
                          No price oracle is configured, so every agent payment is denied (PRICE_UNAVAILABLE). This is
                          the safe default.
                        </div>
                      ) : null}
                      <button
                        className="btn btn-sm btn-outline"
                        disabled={busy !== null}
                        onClick={async () => {
                          setBusy("revoke");
                          const r = await ownerCalls(controller, account.address, [
                            selfCall.revokeSession(account.address, getAddress(agentAddr)),
                          ]);
                          if ("receipt" in r) saveReceipt(r.receipt);
                          setGrantResult(r);
                          setBusy(null);
                          session.refetch();
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ) : null}

                {agentInfo.data?.configured ? (
                  <div className="card bg-base-100 shadow">
                    <div className="card-body gap-3">
                      <h2 className="font-semibold">Try the scripted demo agent</h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {SCENARIOS.map(s => (
                          <button
                            key={s.id}
                            className="btn btn-sm"
                            disabled={busy !== null}
                            title={`Expected: ${s.expect}`}
                            onClick={async () => {
                              setBusy(s.id);
                              const res = await fetch("/api/agent", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                  account: account.address,
                                  scenario: s.id,
                                  to: isAddress(recipient) ? recipient : undefined,
                                }),
                              }).then(r => r.json());
                              if (s.id === "x402") setX402Runs(prev => [res as X402Run, ...prev]);
                              if (res.receipt) {
                                saveReceipt(res.receipt);
                                setRuns(prev => [
                                  { label: s.label, receipt: res.receipt, auditError: res.auditError },
                                  ...prev,
                                ]);
                              }
                              setBusy(null);
                              session.refetch();
                            }}
                          >
                            {busy === s.id ? <span className="loading loading-spinner loading-xs" /> : s.label}
                          </button>
                        ))}
                      </div>
                      {x402Runs.map((r, i) => (
                        <X402Card key={`x402-${i}`} run={r} />
                      ))}
                      {runs.map((r, i) => (
                        <div key={i} className="flex flex-col gap-1">
                          <span className="text-xs font-medium">{r.label}</span>
                          <ReceiptCard receipt={r.receipt} auditError={r.auditError} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          />
        )}
      </AccountGate>
    </div>
  );
};

type X402Run = {
  ok?: boolean;
  steps?: string[];
  error?: string | null;
  hashscan?: string | null;
  settlement?: { success: boolean; transaction: string; payer?: string; errorReason?: string } | null;
  data?: { hbarUsd: number | null; source?: string; readAt?: string } | null;
};

function X402Card({ run }: { run: X402Run }) {
  return (
    <div className={`alert ${run.ok ? "alert-success" : "alert-warning"} flex flex-col items-start gap-1 text-xs`}>
      <span className="font-medium">x402 payment {run.ok ? "settled" : "not completed"}</span>
      {run.steps?.map((s, i) => (
        <span key={i} className="break-all">
          {i + 1}. {s}
        </span>
      ))}
      {run.data?.hbarUsd != null ? <span>Paid data: 1 HBAR = ${run.data.hbarUsd.toFixed(4)}</span> : null}
      {run.error ? <span>Reason: {run.error}</span> : null}
      {run.hashscan ? (
        <a className="link" href={run.hashscan} target="_blank" rel="noreferrer">
          View settlement on HashScan
        </a>
      ) : null}
    </div>
  );
}

function AgentPanel({
  account,
  agent,
  render,
}: {
  account: Address;
  agent: Address | null;
  render: (session: ReturnType<typeof useSession>) => React.ReactNode;
}) {
  const session = useSession(account, agent);
  return <>{render(session)}</>;
}

function useSession(account: Address, agent: Address | null) {
  return useQuery({
    queryKey: ["session", account, agent],
    enabled: Boolean(agent),
    refetchInterval: 15_000,
    queryFn: () => new ConsumerAccountReader(publicClient, account).session(agent!),
  });
}

export default AgentPage;
