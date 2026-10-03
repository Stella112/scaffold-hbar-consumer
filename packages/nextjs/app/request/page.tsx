"use client";

import { useState } from "react";
import { HEDERA_TESTNET, encodePaymentRequest, signPaymentRequest } from "@sh/sdk";
import type { NextPage } from "next";
import { QRCodeSVG } from "qrcode.react";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { assets } from "~~/services/consumer/assets";
import { parseUnits } from "~~/services/consumer/format";

const RequestPage: NextPage = () => {
  const [symbol, setSymbol] = useState("USDC");
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <h1 className="text-2xl font-bold">Request a payment</h1>
      <AccountGate>
        {({ account, controller }) => (
          <div className="card bg-base-100 shadow w-full max-w-md">
            <div className="card-body gap-3">
              <label className="form-control">
                <span className="label-text">Amount</span>
                <div className="join">
                  <input
                    className="input input-bordered join-item w-full"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                  <select
                    className="select select-bordered join-item"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value)}
                  >
                    {assets().map(a => (
                      <option key={a.symbol}>{a.symbol}</option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="form-control">
                <span className="label-text">What&apos;s it for? (optional)</span>
                <input
                  className="input input-bordered"
                  maxLength={100}
                  value={memo}
                  onChange={e => setMemo(e.target.value)}
                />
              </label>
              <label className="form-control">
                <span className="label-text">Expires in (minutes)</span>
                <input className="input input-bordered" value={minutes} onChange={e => setMinutes(e.target.value)} />
              </label>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  setError(null);
                  try {
                    const asset = assets().find(a => a.symbol === symbol)!;
                    const signed = await signPaymentRequest(controller, {
                      chainId: HEDERA_TESTNET.chainId,
                      recipient: account.address,
                      asset: asset.address,
                      amount: parseUnits(amount, asset.decimals),
                      memo,
                      expiresAt: BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(minutes)) * 60),
                      referenceId: crypto.randomUUID().slice(0, 8),
                    });
                    setLink(`${window.location.origin}/pay?r=${encodePaymentRequest(signed)}`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Create request
              </button>
              {error ? <div className="alert alert-error text-sm">{error}</div> : null}
              {link ? (
                <div className="flex flex-col items-center gap-3 pt-2">
                  <div className="bg-white p-3 rounded">
                    <QRCodeSVG value={link} size={220} />
                  </div>
                  <input
                    className="input input-bordered w-full text-xs"
                    readOnly
                    value={link}
                    onFocus={e => e.target.select()}
                  />
                  <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(link)}>
                    Copy link
                  </button>
                  <p className="text-xs opacity-60 text-center">
                    Signed by you. Changing the amount or recipient invalidates the request.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </AccountGate>
    </div>
  );
};

export default RequestPage;
