"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  HBAR,
  HEDERA_TESTNET,
  type PaymentRequestCheck,
  type SignedPaymentRequest,
  decodePaymentRequest,
  testnetDeployment,
  verifyPaymentRequest,
} from "@sh/sdk";
import type { NextPage } from "next";
import type { Address, LocalAccount } from "viem";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { QrScanner } from "~~/components/consumer/QrScanner";
import { ReceiptCard } from "~~/components/consumer/ReceiptCard";
import { saveReceipt } from "~~/services/consumer/activity";
import { assetByAddress } from "~~/services/consumer/assets";
import { type SponsorResponse, publicClient } from "~~/services/consumer/client";
import { SLIPPAGE_BPS, airdrop, deliveryMode, pay, quoteExactOutput, swapToPay } from "~~/services/consumer/execute";
import { formatUnits } from "~~/services/consumer/format";
import type { TokenBalance } from "~~/services/consumer/useConsumerAccount";

type Plan =
  | { kind: "direct" | "airdrop" }
  | { kind: "swap"; tokenIn: Address; tokenInSymbol: string; quotedIn: bigint; decimals: number }
  | { kind: "insufficient"; detail: string };

function extractPayload(input: string): string {
  const t = input.trim();
  try {
    return new URL(t).searchParams.get("r") ?? t;
  } catch {
    return t;
  }
}

function PayForm({
  controller,
  account,
  refresh,
}: {
  controller: LocalAccount;
  account: { address: Address; hbarTinybars: bigint; tokens: TokenBalance[] };
  refresh: () => void;
}) {
  const params = useSearchParams();
  const [raw, setRaw] = useState(params.get("r") ?? "");
  const [scanning, setScanning] = useState(false);
  const [signed, setSigned] = useState<SignedPaymentRequest | null>(null);
  const [check, setCheck] = useState<PaymentRequestCheck | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SponsorResponse | null>(null);

  useEffect(() => {
    setSigned(null);
    setCheck(null);
    setPlan(null);
    setError(null);
    if (!raw.trim()) return;
    (async () => {
      try {
        const s = decodePaymentRequest(extractPayload(raw));
        setSigned(s);
        const c = await verifyPaymentRequest(s, { chainId: HEDERA_TESTNET.chainId, client: publicClient });
        setCheck(c);
        if (!c.valid) return;
        const { asset, amount, recipient } = s.request;
        const held =
          asset === HBAR ? account.hbarTinybars : (account.tokens.find(t => t.address === asset)?.balance ?? 0n);
        if (held >= amount) {
          setPlan({ kind: (await deliveryMode(recipient, asset)) === "airdrop" ? "airdrop" : "direct" });
          return;
        }
        const whbar = testnetDeployment.tokens?.WHBAR;
        if (asset !== HBAR && whbar && asset !== whbar.address) {
          const quotedIn = await quoteExactOutput(whbar.address, asset, amount);
          const maxIn = (quotedIn * (10_000n + SLIPPAGE_BPS)) / 10_000n;
          const have = account.tokens.find(t => t.address === whbar.address)?.balance ?? 0n;
          if (have >= maxIn) {
            setPlan({
              kind: "swap",
              tokenIn: whbar.address,
              tokenInSymbol: "WHBAR",
              quotedIn,
              decimals: whbar.decimals,
            });
            return;
          }
        }
        setPlan({ kind: "insufficient", detail: "Not enough balance to pay this request." });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [raw, account.hbarTinybars, account.tokens]);

  const asset = signed ? assetByAddress(signed.request.asset) : undefined;

  const run = async () => {
    if (!signed || !plan) return;
    setBusy(true);
    setResult(null);
    const { asset: a, recipient, amount } = signed.request;
    let r: SponsorResponse;
    if (plan.kind === "direct") r = await pay(controller, account.address, a, recipient, amount);
    else if (plan.kind === "airdrop") r = await airdrop(controller, account.address, a, recipient, amount);
    else if (plan.kind === "swap")
      r = await swapToPay(controller, account.address, {
        tokenIn: plan.tokenIn,
        tokenOut: a,
        amountOut: amount,
        to: recipient,
        quotedIn: plan.quotedIn,
      });
    else return;
    if ("receipt" in r) saveReceipt(r.receipt);
    setResult(r);
    setBusy(false);
    refresh();
  };

  return (
    <div className="card bg-base-100 shadow w-full max-w-md">
      <div className="card-body gap-3">
        <label className="form-control">
          <span className="label-text">Payment request link or code</span>
          <textarea
            className="textarea textarea-bordered text-xs"
            rows={3}
            value={raw}
            onChange={e => setRaw(e.target.value)}
          />
        </label>
        {scanning ? (
          <QrScanner
            onResult={text => {
              setScanning(false);
              setRaw(text);
            }}
            onClose={() => setScanning(false)}
          />
        ) : (
          <button className="btn btn-sm btn-outline" onClick={() => setScanning(true)}>
            Scan QR code
          </button>
        )}
        {error ? <div className="alert alert-error text-sm">{error}</div> : null}
        {signed && check ? (
          <div className="flex flex-col gap-2">
            <div className="text-3xl font-semibold">
              {asset ? formatUnits(signed.request.amount, asset.decimals) : signed.request.amount.toString()}{" "}
              {asset?.symbol ?? signed.request.asset}
            </div>
            {signed.request.memo ? <div className="opacity-80">“{signed.request.memo}”</div> : null}
            <div className="text-xs opacity-60 break-all">To {signed.request.recipient}</div>
            {check.valid ? (
              <span className="badge badge-success">Verified request</span>
            ) : (
              <span className="badge badge-error">Invalid request: {check.reason}</span>
            )}
          </div>
        ) : null}
        {plan?.kind === "airdrop" ? (
          <div className="alert alert-info text-sm">
            The recipient hasn&apos;t enabled this token yet. It will arrive as a claimable airdrop (HIP-904).
          </div>
        ) : null}
        {plan?.kind === "swap" ? (
          <div className="alert alert-info text-sm">
            You don&apos;t hold {asset?.symbol}. Pay with {plan.tokenInSymbol} via SaucerSwap: about{" "}
            {formatUnits(plan.quotedIn, plan.decimals)} {plan.tokenInSymbol}, at most{" "}
            {formatUnits((plan.quotedIn * (10_000n + SLIPPAGE_BPS)) / 10_000n, plan.decimals)}. The recipient gets
            exactly the requested amount or nothing is paid.
          </div>
        ) : null}
        {plan?.kind === "insufficient" ? <div className="alert alert-warning text-sm">{plan.detail}</div> : null}
        <button
          className="btn btn-primary"
          disabled={!check?.valid || !plan || plan.kind === "insufficient" || busy}
          onClick={run}
        >
          {busy ? <span className="loading loading-spinner" /> : "Pay"}
        </button>
        {result && "receipt" in result ? <ReceiptCard receipt={result.receipt} auditError={result.auditError} /> : null}
        {result && "error" in result ? (
          <ReceiptCard
            receipt={{ status: "denied", action: "payment", account: account.address, reasonCode: result.error }}
          />
        ) : null}
      </div>
    </div>
  );
}

const PayPage: NextPage = () => (
  <div className="flex flex-col items-center grow px-4 py-10 gap-6">
    <h1 className="text-2xl font-bold">Pay</h1>
    <AccountGate>
      {({ controller, account, refresh }) => (
        <Suspense fallback={<span className="loading loading-dots" />}>
          <PayForm controller={controller} account={account} refresh={refresh} />
        </Suspense>
      )}
    </AccountGate>
  </div>
);

export default PayPage;
