"use client";

import { useState } from "react";
import { HEDERA_TESTNET, MirrorClient } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { formatUnits } from "~~/services/consumer/format";

const mirror = new MirrorClient({ baseUrl: process.env.NEXT_PUBLIC_MIRROR_NODE_URL || HEDERA_TESTNET.mirrorUrl });

/**
 * Shown when the account lacks the HBAR an action needs. The sponsor pays network fees, but payments, launches and
 * savings move the account's own funds, so a new account must be funded first.
 */
export function FundAccount({
  account,
  balanceTinybars,
  needTinybars,
  what,
  onFunded,
}: {
  account: Address;
  balanceTinybars: bigint;
  needTinybars: bigint;
  what: string;
  onFunded?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ["faucet", account],
    queryFn: async () =>
      (await fetch(`/api/faucet?account=${account}`)).json() as Promise<{
        enabled: boolean;
        amountHbar?: number;
        alreadyFunded?: boolean;
      }>,
  });
  const hederaId = useQuery({
    queryKey: ["hedera-id", account],
    queryFn: async () => (await mirror.getContract(account))?.contract_id ?? null,
  });
  if (balanceTinybars >= needTinybars) return null;

  return (
    <div className="alert alert-info flex flex-col items-start gap-2 text-sm">
      <span>
        {what} needs {formatUnits(needTinybars, 8, 2)} HBAR in your account; it has {formatUnits(balanceTinybars, 8, 4)}{" "}
        HBAR. Network fees are sponsored, but the amounts you pay come from your account.
      </span>
      <div className="flex flex-wrap gap-2 items-center">
        {info.data?.enabled && !info.data.alreadyFunded ? (
          <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              const r = await fetch("/api/faucet", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ account }),
              }).then(x => x.json() as Promise<{ ok?: boolean; amountHbar?: number; error?: string }>);
              setMsg(r.ok ? `Sent ${r.amountHbar} HBAR. Updating your balance…` : (r.error ?? "Faucet failed"));
              setBusy(false);
              info.refetch();
              if (r.ok) setTimeout(() => onFunded?.(), 4000);
            }}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : `Get ${info.data.amountHbar} demo HBAR`}
          </button>
        ) : null}
        <a className="link text-xs" href="https://portal.hedera.com/faucet" target="_blank" rel="noreferrer">
          or send testnet HBAR from portal.hedera.com/faucet
        </a>
        {hederaId.data ? <code className="text-xs">to {hederaId.data}</code> : null}
      </div>
      {msg ? <span className="text-xs">{msg}</span> : null}
    </div>
  );
}
