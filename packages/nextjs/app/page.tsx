"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { AccountGate } from "~~/components/consumer/AccountGate";
import { FundAccount } from "~~/components/consumer/FundAccount";
import { formatUnits, shortAddr } from "~~/services/consumer/format";

const Home: NextPage = () => (
  <div className="flex flex-col items-center grow px-4 py-10 gap-6">
    <div className="text-center max-w-xl">
      <h1 className="text-3xl font-bold">Your Hedera account</h1>
      <p className="opacity-70 mt-2">Pay, request money and let agents spend safely. You never need HBAR for fees.</p>
    </div>
    <AccountGate>
      {({ account, controller, refresh }) => (
        <div className="card bg-base-100 shadow w-full max-w-xl">
          <div className="card-body gap-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="text-sm opacity-60">Balance</div>
                <div className="text-3xl font-semibold">{formatUnits(account.hbarTinybars, 8, 4)} HBAR</div>
              </div>
              <span className="badge badge-success">Fees sponsored</span>
            </div>
            <ul className="text-sm divide-y divide-base-200">
              {account.tokens.map(t => (
                <li key={t.tokenId} className="flex justify-between py-1">
                  <span>{t.symbol}</span>
                  <span>{formatUnits(t.balance, t.decimals)}</span>
                </li>
              ))}
            </ul>
            <div className="text-xs opacity-60 flex flex-col gap-1">
              <span>Account {account.address}</span>
              <span>
                Your signing key {shortAddr(controller.address)} holds {formatUnits(account.controllerTinybars, 8)} HBAR
                — the sponsor pays network fees.
              </span>
            </div>
            <FundAccount
              account={account.address}
              balanceTinybars={account.hbarTinybars}
              needTinybars={500_000_000n}
              what="Paying, saving, launching and the demo agent"
              onFunded={refresh}
            />
            <div className="grid grid-cols-2 gap-3">
              <Link href="/pay" className="btn btn-primary">
                Pay
              </Link>
              <Link href="/request" className="btn btn-outline">
                Request
              </Link>
            </div>
          </div>
        </div>
      )}
    </AccountGate>
  </div>
);

export default Home;
