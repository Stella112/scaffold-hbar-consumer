"use client";

import { useState } from "react";
import { ReceiptCard } from "./ReceiptCard";
import { HEDERA_TESTNET, testnetDeployment, toSponsorRequest } from "@sh/sdk";
import type { LocalAccount } from "viem";
import { zeroHash } from "viem";
import { type SponsorResponse, sponsor } from "~~/services/consumer/client";
import { useController } from "~~/services/consumer/controller";
import { useConsumerAccount } from "~~/services/consumer/useConsumerAccount";

type Ready = {
  controller: LocalAccount;
  account: NonNullable<ReturnType<typeof useConsumerAccount>["data"]>;
  refresh: () => void;
};

/** Renders children only once the controller key exists and its ConsumerAccount is deployed. */
export function AccountGate({ children }: { children: (r: Ready) => React.ReactNode }) {
  const { controller, ready, create } = useController();
  const q = useConsumerAccount(controller?.address);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SponsorResponse | null>(null);

  if (!testnetDeployment.factory) {
    return (
      <div className="alert alert-warning">
        No ConsumerAccount factory in packages/sdk/deployments/testnet.json yet. Run <code>yarn bootstrap --fund</code>.
      </div>
    );
  }
  if (!ready) return <span className="loading loading-dots" />;
  if (!controller) {
    return (
      <div className="card bg-base-100 shadow p-6 gap-3 max-w-md">
        <h2 className="text-xl font-semibold">Create your account</h2>
        <p className="text-sm opacity-80">
          You don&apos;t need HBAR. Fees are sponsored. A testnet signing key is created in this browser.
        </p>
        <button className="btn btn-primary" onClick={create}>
          Create signing key
        </button>
        <p className="text-xs opacity-60">Testnet only: the key is stored in this browser, not in secure custody.</p>
      </div>
    );
  }
  if (q.isLoading || !q.data) return <span className="loading loading-dots" />;
  if (!q.data.deployed) {
    return (
      <div className="card bg-base-100 shadow p-6 gap-3 max-w-md">
        <h2 className="text-xl font-semibold">Activate your account</h2>
        <p className="text-sm opacity-80">Your account address is reserved. Activation is free — fees are sponsored.</p>
        <code className="text-xs break-all">{q.data.address}</code>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setResult(
              await sponsor(toSponsorRequest.createAccount(HEDERA_TESTNET.chainId, controller.address, zeroHash)),
            );
            setBusy(false);
            q.refetch();
          }}
        >
          {busy ? <span className="loading loading-spinner" /> : "Activate"}
        </button>
        {result && "receipt" in result ? <ReceiptCard receipt={result.receipt} auditError={result.auditError} /> : null}
        {result && "error" in result ? <div className="alert alert-error">{result.error}</div> : null}
      </div>
    );
  }
  return <>{children({ controller, account: q.data, refresh: () => q.refetch() })}</>;
}
