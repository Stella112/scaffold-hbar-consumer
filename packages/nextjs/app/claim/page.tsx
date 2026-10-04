"use client";

import { useState } from "react";
import { HEDERA_TESTNET, MirrorClient, entityIdToLongZero, isEntityId } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { getAddress, isAddress, parseAbi } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-hbar";

const mirror = new MirrorClient({ baseUrl: process.env.NEXT_PUBLIC_MIRROR_NODE_URL || HEDERA_TESTNET.mirrorUrl });
const HTS = "0x0000000000000000000000000000000000000167";
const claimAbi = parseAbi([
  "struct PendingAirdrop { address sender; address receiver; address token; int64 serial; }",
  "function claimAirdrops(PendingAirdrop[] pendingAirdrops) returns (int64 responseCode)",
]);

/** EVM address Mirror Node knows for an account or contract id (alias for ECDSA accounts, else long-zero). */
async function evmOf(id: string) {
  const a = await mirror.getAccount(id).catch(() => null);
  if (a?.evm_address && !/^0x0{24}/i.test(a.evm_address)) return getAddress(a.evm_address);
  return entityIdToLongZero(id);
}

/**
 * HIP-904: tokens sent to an account that is not associated (and has no free auto-association slots) wait as
 * pending airdrops. The recipient claims them with its own key; claiming also associates the token.
 */
const ClaimPage: NextPage = () => {
  const { address: wallet } = useAccount();
  const [lookup, setLookup] = useState("");
  const target = lookup || wallet || "";
  const { writeContractAsync, data: hash, isPending, error } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  const pending = useQuery({
    queryKey: ["pending-airdrops", target, receipt.data?.transactionHash],
    enabled: Boolean(target) && (isAddress(target) || isEntityId(target)),
    refetchInterval: 15_000,
    queryFn: async () => {
      const acct = await mirror.getAccount(target);
      if (!acct) return { accountId: null, receiver: null, items: [] };
      const items = await mirror.getPendingAirdrops(acct.account);
      const tokens = await Promise.all(
        items.map(async i => {
          const t = await mirror.get<{ symbol: string; decimals: string }>(`/tokens/${i.token_id}`).catch(() => null);
          return { ...i, symbol: t?.symbol ?? i.token_id, decimals: Number(t?.decimals ?? 0) };
        }),
      );
      return { accountId: acct.account, receiver: await evmOf(acct.account), items: tokens };
    },
  });
  const mine =
    wallet && pending.data?.receiver && pending.data.receiver.toLowerCase() === wallet.toLowerCase() ? true : false;

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <div className="text-center max-w-xl">
        <h1 className="text-2xl font-bold">Claim tokens</h1>
        <p className="opacity-70 mt-2 text-sm">
          Someone sent you a Hedera token you hadn&apos;t added yet. It&apos;s waiting for you: claim it with your
          wallet and it lands in your account.
        </p>
      </div>
      <div className="card bg-base-100 shadow w-full max-w-xl">
        <div className="card-body gap-3 text-sm">
          <div className="flex justify-between items-center gap-2 flex-wrap">
            <span className="opacity-70">Claim with the Hedera account in your wallet:</span>
            <RainbowKitCustomConnectButton />
          </div>
          <input
            className="input input-bordered input-sm"
            placeholder="…or look up any account (0.0.x or 0x…)"
            value={lookup}
            onChange={e => setLookup(e.target.value.trim())}
          />
          {pending.data?.accountId ? (
            <span className="text-xs opacity-60">Account {pending.data.accountId}</span>
          ) : null}
          {pending.isLoading ? <span className="loading loading-dots" /> : null}
          {pending.data && !pending.data.items.length ? <span className="opacity-60">No tokens waiting.</span> : null}
          {pending.data?.items.map(i => (
            <div
              key={`${i.sender_id}-${i.token_id}`}
              className="flex justify-between items-center border-t border-base-200 pt-2"
            >
              <span>
                {(i.amount / 10 ** i.decimals).toLocaleString()} {i.symbol}{" "}
                <span className="opacity-60 text-xs">from {i.sender_id}</span>
              </span>
              <button
                className="btn btn-sm btn-primary"
                disabled={!mine || isPending}
                title={mine ? "" : "Connect the receiving account's wallet to claim"}
                onClick={async () =>
                  writeContractAsync({
                    address: HTS,
                    abi: claimAbi,
                    functionName: "claimAirdrops",
                    args: [
                      [
                        {
                          sender: await evmOf(i.sender_id),
                          receiver: pending.data!.receiver!,
                          token: entityIdToLongZero(i.token_id),
                          serial: 0n,
                        },
                      ],
                    ],
                    gas: 1_500_000n,
                  })
                }
              >
                Claim
              </button>
            </div>
          ))}
          {receipt.data ? (
            <div className={`alert ${receipt.data.status === "success" ? "alert-success" : "alert-error"} text-xs`}>
              {receipt.data.status === "success" ? "Claimed — confirmed on Hedera." : "Claim failed on chain."}{" "}
              <a
                className="link"
                href={`${HEDERA_TESTNET.hashscan}/transaction/${hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on HashScan
              </a>
            </div>
          ) : null}
          {error ? <div className="alert alert-error text-xs">{error.message.split("\n")[0]}</div> : null}
        </div>
      </div>
    </div>
  );
};

export default ClaimPage;
