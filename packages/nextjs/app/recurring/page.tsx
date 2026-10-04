"use client";

import { useState } from "react";
import {
  ConsumerAccountReader,
  HBAR,
  HEDERA_TESTNET,
  MirrorClient,
  isEntityId,
  resolveX402PayTo,
  selfCall,
} from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { type Address, getAddress, isAddress } from "viem";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { FundAccount } from "~~/components/consumer/FundAccount";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import { type SponsorResponse, publicClient } from "~~/services/consumer/client";
import { ownerCalls } from "~~/services/consumer/execute";
import { formatUnits, parseUnits, shortAddr } from "~~/services/consumer/format";

const mirror = new MirrorClient({ baseUrl: process.env.NEXT_PUBLIC_MIRROR_NODE_URL ?? HEDERA_TESTNET.mirrorUrl });

/**
 * HBAR the account should hold per instalment for the scheduled transaction's fees: ~2M gas (payment + scheduling
 * the next instalment through HSS) at the testnet gas price.
 */
const FEE_RESERVE_TINYBARS_PER_PAYMENT = 180_000_000n;

const RecurringPage: NextPage = () => {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [minutes, setMinutes] = useState("60");
  const [count, setCount] = useState("3");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SponsorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <div className="text-center max-w-xl">
        <h1 className="text-2xl font-bold">Recurring payments</h1>
        <p className="opacity-70 mt-2 text-sm">
          Scheduled by Hedera itself (Schedule Service): each payment runs on time with no app, server or bot involved,
          and schedules the next one.
        </p>
      </div>
      <AccountGate>
        {({ controller, account, refresh }) => (
          <Subscriptions account={account.address}>
            {subs => (
              <div className="w-full max-w-xl flex flex-col gap-4">
                <div className="card bg-base-100 shadow">
                  <div className="card-body gap-3">
                    <h2 className="font-semibold">New recurring HBAR payment</h2>
                    <input
                      className="input input-bordered text-sm"
                      placeholder="Recipient 0.0.x or 0x…"
                      value={to}
                      onChange={e => setTo(e.target.value.trim())}
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <label className="form-control">
                        <span className="label-text text-xs">HBAR each time</span>
                        <input
                          className="input input-bordered input-sm"
                          value={amount}
                          onChange={e => setAmount(e.target.value)}
                        />
                      </label>
                      <label className="form-control">
                        <span className="label-text text-xs">Every (minutes)</span>
                        <input
                          className="input input-bordered input-sm"
                          value={minutes}
                          onChange={e => setMinutes(e.target.value)}
                        />
                      </label>
                      <label className="form-control">
                        <span className="label-text text-xs">Times</span>
                        <input
                          className="input input-bordered input-sm"
                          value={count}
                          onChange={e => setCount(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="text-xs opacity-70">
                      Scheduled payments are paid for by your account, so keep about{" "}
                      {formatUnits(FEE_RESERVE_TINYBARS_PER_PAYMENT * BigInt(Math.max(1, Number(count) || 1)), 8, 2)}{" "}
                      HBAR extra for fees. Balance: {formatUnits(account.hbarTinybars, 8, 4)} HBAR.
                    </p>
                    <FundAccount
                      account={account.address}
                      balanceTinybars={account.hbarTinybars}
                      needTinybars={
                        FEE_RESERVE_TINYBARS_PER_PAYMENT * BigInt(Math.max(1, Number(count) || 1)) +
                        parseUnits(amount || "0", 8) * BigInt(Math.max(1, Number(count) || 1))
                      }
                      what="These scheduled payments (amounts + fees)"
                      onFunded={refresh}
                    />
                    {error ? <div className="alert alert-error text-xs">{error}</div> : null}
                    <button
                      className="btn btn-primary"
                      disabled={busy !== null || !(isAddress(to) || isEntityId(to))}
                      onClick={async () => {
                        setError(null);
                        setBusy("create");
                        try {
                          const recipient: Address = isAddress(to)
                            ? getAddress(to)
                            : await resolveX402PayTo(mirror, to);
                          const intervalSeconds = BigInt(Math.max(1, Number(minutes)) * 60);
                          const r = await ownerCalls(controller, account.address, [
                            selfCall.createSubscription(account.address, {
                              asset: HBAR,
                              to: recipient,
                              amount: parseUnits(amount, 8),
                              intervalSeconds,
                              firstAt: BigInt(Math.floor(Date.now() / 1000)) + intervalSeconds,
                              count: Math.max(1, Math.floor(Number(count))),
                            }),
                          ]);
                          if ("receipt" in r) saveReceipt(r.receipt);
                          setResult(r);
                          subs.refetch();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                        setBusy(null);
                      }}
                    >
                      {busy === "create" ? (
                        <span className="loading loading-spinner loading-sm" />
                      ) : (
                        "Schedule payments"
                      )}
                    </button>
                    {result && "receipt" in result ? (
                      <ReceiptCard receipt={result.receipt} auditError={result.auditError} />
                    ) : null}
                  </div>
                </div>

                <div className="card bg-base-100 shadow">
                  <div className="card-body gap-2">
                    <h2 className="font-semibold">Your recurring payments</h2>
                    {!subs.data?.length ? <p className="text-sm opacity-60">None yet.</p> : null}
                    {subs.data?.map(s => (
                      <div
                        key={s.id.toString()}
                        className="flex justify-between items-center gap-2 text-sm border-t border-base-200 pt-2"
                      >
                        <div className="flex flex-col">
                          <span>
                            {formatUnits(s.amount, 8)} HBAR → {shortAddr(s.to)} every {Number(s.interval) / 60} min
                          </span>
                          <span className="text-xs opacity-60">
                            {s.remaining > 0
                              ? `${s.remaining} left · next ${new Date(Number(s.nextAt) * 1000).toLocaleString()}`
                              : "finished or cancelled"}
                            {s.schedule !== "0x0000000000000000000000000000000000000000"
                              ? " · scheduled on Hedera"
                              : ""}
                          </span>
                        </div>
                        {s.remaining > 0 ? (
                          <button
                            className="btn btn-xs btn-outline"
                            disabled={busy !== null}
                            onClick={async () => {
                              setBusy(`cancel-${s.id}`);
                              const r = await ownerCalls(controller, account.address, [
                                selfCall.cancelSubscription(account.address, s.id),
                              ]);
                              if ("receipt" in r) saveReceipt(r.receipt);
                              setResult(r);
                              setBusy(null);
                              subs.refetch();
                            }}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Subscriptions>
        )}
      </AccountGate>
    </div>
  );
};

function Subscriptions({
  account,
  children,
}: {
  account: Address;
  children: (q: ReturnType<typeof useSubscriptions>) => React.ReactNode;
}) {
  return <>{children(useSubscriptions(account))}</>;
}

function useSubscriptions(account: Address) {
  return useQuery({
    queryKey: ["subscriptions", account],
    refetchInterval: 15_000,
    queryFn: () => new ConsumerAccountReader(publicClient, account).subscriptions(),
  });
}

export default RecurringPage;
