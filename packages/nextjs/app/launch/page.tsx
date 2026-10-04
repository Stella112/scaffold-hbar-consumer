"use client";

import { useState } from "react";
import { longZeroToEntityId, testnetDeployment, tokenLaunchpadAbi } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { FundAccount } from "~~/components/consumer/FundAccount";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import { type SponsorResponse, publicClient } from "~~/services/consumer/client";
import { launchBuy, launchCall, launchToken } from "~~/services/consumer/execute";
import { formatUnits, parseUnits, shortAddr } from "~~/services/consumer/format";

const pad = testnetDeployment.launchpad;
/** HBAR sent to cover the HTS token-creation fee (about $1); the unspent part is refunded. */
const CREATION_FEE_TINYBARS = 2_000_000_000n;

const LaunchPage: NextPage = () => {
  const [form, setForm] = useState({
    name: "",
    symbol: "",
    supply: "1000000",
    forSale: "600000",
    price: "0.01",
    target: "10",
    hours: "24",
  });
  const [buyAmount, setBuyAmount] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SponsorResponse | null>(null);
  const launches = useQuery({
    queryKey: ["launches"],
    enabled: Boolean(pad),
    refetchInterval: 15_000,
    queryFn: async () => {
      const n = await publicClient.readContract({
        address: pad!.address,
        abi: tokenLaunchpadAbi,
        functionName: "launchCount",
      });
      const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(n) - 1n - BigInt(i)).slice(0, 20);
      return Promise.all(
        ids.map(async id => ({
          id,
          ...(await publicClient.readContract({
            address: pad!.address,
            abi: tokenLaunchpadAbi,
            functionName: "launches",
            args: [id],
          })),
        })),
      );
    },
  });
  const field = (k: keyof typeof form, label: string) => (
    <label className="form-control">
      <span className="label-text text-xs">{label}</span>
      <input
        className="input input-bordered input-sm"
        value={form[k]}
        onChange={e => setForm({ ...form, [k]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <div className="text-center max-w-xl">
        <h1 className="text-2xl font-bold">Launch a token</h1>
        <p className="opacity-70 mt-2 text-sm">
          Create a fixed-supply Hedera token nobody can mint more of or freeze. Sell it at a fixed price: if the target
          is reached it graduates once and you receive the HBAR; if not, every buyer gets a refund.
        </p>
      </div>
      {!pad ? (
        <div className="alert alert-warning max-w-xl">
          No launchpad in this deployment. Run `yarn bootstrap --fund`.
        </div>
      ) : (
        <AccountGate>
          {({ controller, account, refresh }) => {
            const run = async (label: string, fn: () => Promise<SponsorResponse>) => {
              setBusy(label);
              const r = await fn();
              if ("receipt" in r) saveReceipt(r.receipt);
              setResult(r);
              setBusy(null);
              launches.refetch();
            };
            return (
              <div className="w-full max-w-2xl flex flex-col gap-4">
                <div className="card bg-base-100 shadow">
                  <div className="card-body gap-3">
                    <h2 className="font-semibold">New launch</h2>
                    <div className="grid grid-cols-2 gap-2">
                      {field("name", "Name")}
                      {field("symbol", "Symbol")}
                      {field("supply", "Total supply")}
                      {field("forSale", "For sale")}
                      {field("price", "Price (HBAR per token)")}
                      {field("target", "Graduation target (HBAR)")}
                      {field("hours", "Sale length (hours)")}
                    </div>
                    <p className="text-xs opacity-60">
                      Your account pays the Hedera token-creation fee (about $1;{" "}
                      {formatUnits(CREATION_FEE_TINYBARS, 8, 0)} HBAR is sent and the rest comes back). Balance:{" "}
                      {formatUnits(account.hbarTinybars, 8, 2)} HBAR. Tokens use 2 decimals.
                    </p>
                    <FundAccount
                      account={account.address}
                      balanceTinybars={account.hbarTinybars}
                      needTinybars={CREATION_FEE_TINYBARS}
                      what="Launching a token"
                      onFunded={refresh}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={
                        busy !== null || !form.name || !form.symbol || account.hbarTinybars < CREATION_FEE_TINYBARS
                      }
                      onClick={() =>
                        run("launch", () =>
                          launchToken(
                            controller,
                            account.address,
                            {
                              name: form.name,
                              symbol: form.symbol.toUpperCase(),
                              decimals: 2,
                              supply: parseUnits(form.supply, 2),
                              forSale: parseUnits(form.forSale, 2),
                              priceTinybars: parseUnits(form.price, 8),
                              target: parseUnits(form.target, 8),
                              duration: BigInt(Math.round(Number(form.hours) * 3600)),
                            },
                            CREATION_FEE_TINYBARS,
                          ),
                        )
                      }
                    >
                      {busy === "launch" ? <span className="loading loading-spinner loading-sm" /> : "Launch"}
                    </button>
                    {result && "receipt" in result ? (
                      <ReceiptCard receipt={result.receipt} auditError={result.auditError} />
                    ) : null}
                  </div>
                </div>

                <div className="card bg-base-100 shadow">
                  <div className="card-body gap-3">
                    <h2 className="font-semibold">Launches</h2>
                    {!launches.data?.length ? <p className="text-sm opacity-60">None yet.</p> : null}
                    {launches.data?.map(l => {
                      const key = l.id.toString();
                      const now = Date.now() / 1000;
                      const open = !l.graduated && now < Number(l.deadline);
                      const failed = !l.graduated && now >= Number(l.deadline) && l.raised < l.target;
                      const mine = l.creator.toLowerCase() === account.address.toLowerCase();
                      return (
                        <div key={key} className="border border-base-200 rounded-lg p-3 flex flex-col gap-2 text-sm">
                          <div className="flex justify-between">
                            <span className="font-medium">
                              #{key} · {longZeroToEntityId(l.token) ?? shortAddr(l.token)} {mine ? "· yours" : ""}
                            </span>
                            <span
                              className={`badge ${l.graduated ? "badge-success" : failed ? "badge-error" : "badge-info"}`}
                            >
                              {l.graduated
                                ? "graduated"
                                : failed
                                  ? "refunds open"
                                  : open
                                    ? "on sale"
                                    : "ready to graduate"}
                            </span>
                          </div>
                          <progress
                            className="progress progress-primary"
                            value={Number(l.raised)}
                            max={Number(l.target)}
                          />
                          <span className="text-xs opacity-70">
                            {formatUnits(l.raised, 8, 2)} / {formatUnits(l.target, 8, 2)} HBAR raised ·{" "}
                            {formatUnits(l.sold, l.decimals)} / {formatUnits(l.forSale, l.decimals)} sold at{" "}
                            {formatUnits(l.priceTinybars, 8)} HBAR · ends{" "}
                            {new Date(Number(l.deadline) * 1000).toLocaleString()}
                          </span>
                          <div className="flex gap-2 flex-wrap">
                            {open ? (
                              <div className="join">
                                <input
                                  className="input input-bordered input-xs join-item w-24"
                                  placeholder="tokens"
                                  value={buyAmount[key] ?? ""}
                                  onChange={e => setBuyAmount({ ...buyAmount, [key]: e.target.value })}
                                />
                                <button
                                  className="btn btn-xs btn-primary join-item"
                                  disabled={busy !== null || !buyAmount[key]}
                                  onClick={() =>
                                    run(`buy-${key}`, () =>
                                      launchBuy(
                                        controller,
                                        account.address,
                                        l.id,
                                        parseUnits(buyAmount[key]!, l.decimals),
                                      ),
                                    )
                                  }
                                >
                                  Buy
                                </button>
                              </div>
                            ) : null}
                            {!l.graduated && l.raised >= l.target ? (
                              <button
                                className="btn btn-xs"
                                disabled={busy !== null}
                                onClick={() =>
                                  run(`grad-${key}`, () => launchCall(controller, account.address, "graduate", l.id))
                                }
                              >
                                Graduate
                              </button>
                            ) : null}
                            {l.graduated ? (
                              <IfOwed
                                id={l.id}
                                account={account.address}
                                kind="bought"
                                creatorShare={mine && !l.creatorClaimed}
                              >
                                <button
                                  className="btn btn-xs"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    run(`claim-${key}`, () =>
                                      launchCall(controller, account.address, "claim", l.id, l.token),
                                    )
                                  }
                                >
                                  Claim tokens
                                </button>
                              </IfOwed>
                            ) : null}
                            {failed ? (
                              <IfOwed id={l.id} account={account.address} kind="paid" creatorShare={false}>
                                <button
                                  className="btn btn-xs"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    run(`refund-${key}`, () => launchCall(controller, account.address, "refund", l.id))
                                  }
                                >
                                  Refund
                                </button>
                              </IfOwed>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          }}
        </AccountGate>
      )}
    </div>
  );
};

/** Renders its children only if this account is owed something by the launch (tokens to claim / HBAR to refund). */
function IfOwed({
  id,
  account,
  kind,
  creatorShare,
  children,
}: {
  id: bigint;
  account: `0x${string}` | string;
  kind: "bought" | "paid";
  creatorShare: boolean;
  children: React.ReactNode;
}) {
  const owed = useQuery({
    queryKey: ["launch-owed", id.toString(), account, kind],
    refetchInterval: 15_000,
    queryFn: () =>
      publicClient.readContract({
        address: pad!.address,
        abi: tokenLaunchpadAbi,
        functionName: kind,
        args: [id, account as `0x${string}`],
      }),
  });
  if (!creatorShare && !(owed.data && owed.data > 0n)) return null;
  return <>{children}</>;
}

export default LaunchPage;
