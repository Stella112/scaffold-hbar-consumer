"use client";

import { useState } from "react";
import { testnetDeployment } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import type { Address } from "viem";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { FundAccount } from "~~/components/consumer/FundAccount";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import type { SponsorResponse } from "~~/services/consumer/client";
import { vaultDeposit, vaultPosition, vaultRedeem, wrapHbar } from "~~/services/consumer/execute";
import { formatUnits, parseUnits } from "~~/services/consumer/format";

const vault = testnetDeployment.vaults?.WHBAR;

const SavePage: NextPage = () => {
  const [amount, setAmount] = useState("0.5");
  const [wrapAmount, setWrapAmount] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SponsorResponse | null>(null);

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <div className="text-center max-w-xl">
        <h1 className="text-2xl font-bold">Savings</h1>
        <p className="opacity-70 mt-2 text-sm">
          Put WHBAR aside in a savings vault. Agents you allow can add to your savings, but only you can take money out
          — your account enforces that on Hedera.
        </p>
      </div>
      {!vault ? (
        <div className="alert alert-warning max-w-xl">
          No savings vault in this deployment. Run `yarn bootstrap --fund`.
        </div>
      ) : (
        <AccountGate>
          {({ controller, account, refresh }) => (
            <Position account={account.address} vault={vault.address} asset={vault.asset}>
              {pos => {
                const run = async (label: string, fn: () => Promise<SponsorResponse>) => {
                  setBusy(label);
                  const r = await fn();
                  if ("receipt" in r) saveReceipt(r.receipt);
                  setResult(r);
                  setBusy(null);
                  pos.refetch();
                };
                return (
                  <div className="w-full max-w-xl flex flex-col gap-4">
                    <div className="card bg-base-100 shadow">
                      <div className="card-body gap-2">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-sm opacity-60">Saved</div>
                            <div className="text-2xl font-semibold">
                              {formatUnits(pos.data?.saved ?? 0n, 8, 4)} WHBAR
                            </div>
                          </div>
                          <div>
                            <div className="text-sm opacity-60">Available</div>
                            <div className="text-2xl font-semibold">
                              {formatUnits(pos.data?.liquid ?? 0n, 8, 4)} WHBAR
                            </div>
                          </div>
                        </div>
                        <div className="text-xs opacity-60">
                          Vault {vault.contractId ?? vault.address} · {formatUnits(account.hbarTinybars, 8, 4)} HBAR in
                          your account
                        </div>
                      </div>
                    </div>

                    <div className="card bg-base-100 shadow">
                      <div className="card-body gap-3">
                        <h2 className="font-semibold">Save</h2>
                        <FundAccount
                          account={account.address}
                          balanceTinybars={account.hbarTinybars}
                          needTinybars={100_000_000n}
                          what="Wrapping HBAR to save"
                          onFunded={refresh}
                        />
                        {(pos.data?.liquid ?? 0n) < parseUnits(amount || "0", 8) ? (
                          <div className="alert alert-warning text-xs">
                            You have {formatUnits(pos.data?.liquid ?? 0n, 8, 4)} WHBAR. Wrap some HBAR below first.
                          </div>
                        ) : null}
                        <div className="join w-full">
                          <input
                            className="input input-bordered join-item w-full"
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                          />
                          <button
                            className="btn btn-primary join-item"
                            disabled={busy !== null || (pos.data?.liquid ?? 0n) < parseUnits(amount || "0", 8)}
                            onClick={() =>
                              run("save", () =>
                                vaultDeposit(controller, account.address, vault.address, parseUnits(amount, 8)),
                              )
                            }
                          >
                            {busy === "save" ? <span className="loading loading-spinner loading-sm" /> : "Save WHBAR"}
                          </button>
                        </div>
                        <div className="join w-full">
                          <input
                            className="input input-bordered input-sm join-item w-full"
                            value={wrapAmount}
                            onChange={e => setWrapAmount(e.target.value)}
                          />
                          <button
                            className="btn btn-sm join-item"
                            disabled={busy !== null}
                            onClick={() =>
                              run("wrap", () => wrapHbar(controller, account.address, parseUnits(wrapAmount, 8)))
                            }
                          >
                            {busy === "wrap" ? (
                              <span className="loading loading-spinner loading-xs" />
                            ) : (
                              "Wrap HBAR → WHBAR"
                            )}
                          </button>
                        </div>
                        <button
                          className="btn btn-outline"
                          disabled={busy !== null || !pos.data?.shares}
                          onClick={() =>
                            run("withdraw", () =>
                              vaultRedeem(controller, account.address, vault.address, pos.data!.shares),
                            )
                          }
                        >
                          {busy === "withdraw" ? (
                            <span className="loading loading-spinner loading-sm" />
                          ) : (
                            "Withdraw all"
                          )}
                        </button>
                        <p className="text-xs opacity-60">
                          To let an agent save for you, include “vault-deposit” when you grant it an allowance (Agent
                          page). Its deposits count against its USD limits; it can never withdraw or transfer your
                          savings.
                        </p>
                        {result && "receipt" in result ? (
                          <ReceiptCard receipt={result.receipt} auditError={result.auditError} />
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              }}
            </Position>
          )}
        </AccountGate>
      )}
    </div>
  );
};

function Position({
  account,
  vault,
  asset,
  children,
}: {
  account: Address;
  vault: Address;
  asset: Address;
  children: (q: ReturnType<typeof usePosition>) => React.ReactNode;
}) {
  return <>{children(usePosition(account, vault, asset))}</>;
}

function usePosition(account: Address, vault: Address, asset: Address) {
  return useQuery({
    queryKey: ["vault", account, vault],
    refetchInterval: 15_000,
    queryFn: () => vaultPosition(account, vault, asset),
  });
}

export default SavePage;
