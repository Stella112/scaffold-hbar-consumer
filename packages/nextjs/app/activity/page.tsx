"use client";

import { useEffect, useState } from "react";
import type { NextPage } from "next";
import { loadReceipts } from "~~/services/consumer/activity";
import { type ReceiptJson, hashscanTx } from "~~/services/consumer/client";

const ActivityPage: NextPage = () => {
  const [items, setItems] = useState<(ReceiptJson & { savedAt?: string })[]>([]);
  useEffect(() => setItems(loadReceipts()), []);
  return (
    <div className="flex flex-col items-center grow px-4 py-10 gap-6">
      <h1 className="text-2xl font-bold">Activity</h1>
      <p className="text-xs opacity-60">Receipts saved in this browser. Each links to the network record.</p>
      <div className="w-full max-w-2xl flex flex-col gap-2">
        {items.length === 0 ? <div className="opacity-60 text-center">No activity yet.</div> : null}
        {items.map((r, i) => {
          const tx = (r.transactionId as string | null) ?? (r.transactionHash as string | null);
          return (
            <div key={i} className="card bg-base-100 shadow-sm">
              <div className="card-body py-3 flex-row justify-between items-center">
                <div>
                  <div className="font-medium capitalize">{String(r.action).replace(/([A-Z])/g, " $1")}</div>
                  <div className="text-xs opacity-60">{r.savedAt ? new Date(r.savedAt).toLocaleString() : ""}</div>
                </div>
                <div className="text-right text-sm">
                  {r.status === "success" ? (
                    <span className="badge badge-success">Paid</span>
                  ) : (
                    <span className="badge badge-error">{r.reasonCode}</span>
                  )}
                  {tx ? (
                    <a className="link block text-xs" href={hashscanTx(tx)} target="_blank" rel="noreferrer">
                      HashScan
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActivityPage;
