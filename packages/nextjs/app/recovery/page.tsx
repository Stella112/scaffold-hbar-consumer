"use client";

import { useState } from "react";
import { consumerAccountAbi, selfCall } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { type Address, encodeFunctionData, getAddress, isAddress } from "viem";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import { type SponsorResponse, publicClient } from "~~/services/consumer/client";
import { useController, writeLinkedAccount } from "~~/services/consumer/controller";
import { ownerCalls } from "~~/services/consumer/execute";
import { shortAddr } from "~~/services/consumer/format";

const ZERO = "0x0000000000000000000000000000000000000000";

async function recoveryState(account: Address) {
  const read = <T,>(functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: account, abi: consumerAccountAbi, functionName, args } as never) as Promise<T>;
  const [owner, guardians, threshold, delay, recovery] = await Promise.all([
    read<Address>("owner"),
    read<readonly Address[]>("guardians"),
    read<number>("guardianThreshold"),
    read<bigint>("recoveryDelay"),
    read<readonly [Address, bigint, bigint, number]>("recovery"),
  ]);
  const [newOwner, round, executableAt, approvals] = recovery;
  return { owner, guardians, threshold, delay, newOwner, round, executableAt, approvals };
}

const RecoveryPage: NextPage = () => {
  const [result, setResult] = useState<SponsorResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [guardianInput, setGuardianInput] = useState("");
  const [threshold, setThreshold] = useState("2");
  const [delayMin, setDelayMin] = useState("60");
  const [friend, setFriend] = useState("");
  const [friendNewOwner, setFriendNewOwner] = useState("");
  const [link, setLink] = useState("");
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const { controller } = useController();

  const friendState = useQuery({
    queryKey: ["recovery", friend],
    enabled: isAddress(friend),
    refetchInterval: 15_000,
    queryFn: () => recoveryState(getAddress(friend)),
  });

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <div className="text-center max-w-xl">
        <h1 className="text-2xl font-bold">Recovery</h1>
        <p className="opacity-70 mt-2 text-sm">
          Choose guardians who can together give your account a new key if you lose yours, after a waiting period you
          can cancel. Agents can never become guardians or change these rules.
        </p>
      </div>

      <div className="card bg-base-100 shadow w-full max-w-xl">
        <div className="card-body gap-2 text-sm">
          <h2 className="font-semibold">Lost your key?</h2>
          <p className="opacity-70">
            Share this browser&apos;s key with your guardians; they propose it as your account&apos;s new owner.
          </p>
          <code className="text-xs break-all">{controller?.address ?? "Create a key on Home first"}</code>
          <p className="opacity-70">Once recovery has executed, link your old account here:</p>
          <div className="join w-full">
            <input
              className="input input-bordered input-sm join-item w-full"
              placeholder="Recovered account 0x…"
              value={link}
              onChange={e => setLink(e.target.value.trim())}
            />
            <button
              className="btn btn-sm join-item"
              disabled={!isAddress(link) || !controller}
              onClick={async () => {
                const s = await recoveryState(getAddress(link)).catch(() => null);
                if (!s || s.owner.toLowerCase() !== controller!.address.toLowerCase()) {
                  setLinkMsg("This key is not the owner of that account yet. Has recovery executed?");
                  return;
                }
                writeLinkedAccount(getAddress(link));
                setLinkMsg("Linked. Reloading…");
                setTimeout(() => location.assign("/"), 800);
              }}
            >
              Link account
            </button>
          </div>
          {linkMsg ? <span className="text-xs">{linkMsg}</span> : null}
        </div>
      </div>

      <AccountGate>
        {({ controller, account }) => (
          <Mine account={account.address}>
            {mine => {
              const run = async (label: string, fn: () => Promise<SponsorResponse>) => {
                setBusy(label);
                const r = await fn();
                if ("receipt" in r) saveReceipt(r.receipt);
                setResult(r);
                setBusy(null);
                mine.refetch();
                friendState.refetch();
              };
              const d = mine.data;
              const pending = d && d.newOwner !== ZERO;
              const f = friendState.data;
              const friendPending = f && f.newOwner !== ZERO;
              const iAmGuardian = f?.guardians.some(g => g.toLowerCase() === account.address.toLowerCase());
              const friendCall = (label: string, data: `0x${string}`) =>
                run(label, () =>
                  ownerCalls(controller, account.address, [{ target: getAddress(friend), value: 0n, data }]),
                );
              return (
                <div className="w-full max-w-xl flex flex-col gap-4">
                  <div className="card bg-base-100 shadow">
                    <div className="card-body gap-3 text-sm">
                      <h2 className="font-semibold">Your guardians</h2>
                      {d?.guardians.length ? (
                        <div className="flex flex-col gap-1">
                          {d.guardians.map(g => (
                            <code key={g} className="text-xs">
                              {g}
                            </code>
                          ))}
                          <span className="opacity-70">
                            {d.threshold} of {d.guardians.length} must approve · waiting period {Number(d.delay) / 60}{" "}
                            min
                          </span>
                        </div>
                      ) : (
                        <span className="opacity-70">None yet.</span>
                      )}
                      {pending ? (
                        <div className="alert alert-warning flex flex-col items-start gap-2">
                          <span>
                            Recovery in progress: new owner {shortAddr(d.newOwner)}, {d.approvals} approval(s)
                            {d.executableAt
                              ? `, can execute after ${new Date(Number(d.executableAt) * 1000).toLocaleString()}`
                              : ""}
                            . If this wasn&apos;t you, cancel it.
                          </span>
                          <button
                            className="btn btn-sm"
                            disabled={busy !== null}
                            onClick={() =>
                              run("cancel", () =>
                                ownerCalls(controller, account.address, [selfCall.cancelRecovery(account.address)]),
                              )
                            }
                          >
                            Cancel recovery
                          </button>
                        </div>
                      ) : null}
                      <textarea
                        className="textarea textarea-bordered text-xs"
                        placeholder="Guardian account addresses (0x…), one per line — e.g. friends' accounts"
                        value={guardianInput}
                        onChange={e => setGuardianInput(e.target.value)}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <label className="form-control">
                          <span className="label-text text-xs">Approvals needed</span>
                          <input
                            className="input input-bordered input-sm"
                            value={threshold}
                            onChange={e => setThreshold(e.target.value)}
                          />
                        </label>
                        <label className="form-control">
                          <span className="label-text text-xs">Waiting period (min, ≥ 5)</span>
                          <input
                            className="input input-bordered input-sm"
                            value={delayMin}
                            onChange={e => setDelayMin(e.target.value)}
                          />
                        </label>
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={busy !== null}
                        onClick={() => {
                          const list = guardianInput
                            .split(/[\s,]+/)
                            .filter(a => isAddress(a))
                            .map(a => getAddress(a));
                          return run("guardians", () =>
                            ownerCalls(controller, account.address, [
                              selfCall.setGuardians(
                                account.address,
                                list,
                                Math.max(0, Math.min(list.length, Number(threshold) || 0)),
                                BigInt(Math.max(5, Number(delayMin) || 5) * 60),
                              ),
                            ]),
                          );
                        }}
                      >
                        Save guardians
                      </button>
                    </div>
                  </div>

                  <div className="card bg-base-100 shadow">
                    <div className="card-body gap-3 text-sm">
                      <h2 className="font-semibold">Help a friend recover</h2>
                      <p className="opacity-70">
                        If a friend made your account ({shortAddr(account.address)}) one of their guardians, you can act
                        from here. Fees are sponsored.
                      </p>
                      <input
                        className="input input-bordered input-sm"
                        placeholder="Friend's account 0x…"
                        value={friend}
                        onChange={e => setFriend(e.target.value.trim())}
                      />
                      {f ? (
                        <span className="text-xs opacity-80">
                          {iAmGuardian
                            ? "You are a guardian of this account."
                            : "You are not a guardian of this account."}{" "}
                          {friendPending
                            ? `Recovery to ${shortAddr(f.newOwner)}: ${f.approvals}/${f.threshold} approvals${
                                f.executableAt
                                  ? `, executable after ${new Date(Number(f.executableAt) * 1000).toLocaleString()}`
                                  : ""
                              }.`
                            : "No recovery in progress."}
                        </span>
                      ) : null}
                      {f && !friendPending ? (
                        <div className="join w-full">
                          <input
                            className="input input-bordered input-sm join-item w-full"
                            placeholder="Friend's new key 0x… (they see it on this page)"
                            value={friendNewOwner}
                            onChange={e => setFriendNewOwner(e.target.value.trim())}
                          />
                          <button
                            className="btn btn-sm join-item"
                            disabled={busy !== null || !iAmGuardian || !isAddress(friendNewOwner)}
                            onClick={() =>
                              friendCall(
                                "propose",
                                encodeFunctionData({
                                  abi: consumerAccountAbi,
                                  functionName: "proposeRecovery",
                                  args: [getAddress(friendNewOwner)],
                                }),
                              )
                            }
                          >
                            Propose
                          </button>
                        </div>
                      ) : null}
                      {friendPending ? (
                        <div className="flex gap-2">
                          <button
                            className="btn btn-sm"
                            disabled={busy !== null || !iAmGuardian}
                            onClick={() =>
                              friendCall(
                                "approve",
                                encodeFunctionData({
                                  abi: consumerAccountAbi,
                                  functionName: "approveRecovery",
                                  args: [],
                                }),
                              )
                            }
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={busy !== null || !f.executableAt || Date.now() / 1000 < Number(f.executableAt)}
                            onClick={() =>
                              friendCall(
                                "execute",
                                encodeFunctionData({
                                  abi: consumerAccountAbi,
                                  functionName: "executeRecovery",
                                  args: [],
                                }),
                              )
                            }
                          >
                            Execute
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {result && "receipt" in result ? (
                    <ReceiptCard receipt={result.receipt} auditError={result.auditError} />
                  ) : null}
                </div>
              );
            }}
          </Mine>
        )}
      </AccountGate>
    </div>
  );
};

function Mine({
  account,
  children,
}: {
  account: Address;
  children: (q: ReturnType<typeof useMine>) => React.ReactNode;
}) {
  return <>{children(useMine(account))}</>;
}

function useMine(account: Address) {
  return useQuery({ queryKey: ["recovery", account], refetchInterval: 15_000, queryFn: () => recoveryState(account) });
}

export default RecoveryPage;
