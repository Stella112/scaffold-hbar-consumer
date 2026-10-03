"use client";

import { type ReceiptJson, hashscanTx } from "~~/services/consumer/client";

const REASON_COPY: Record<string, string> = {
  SESSION_EXPIRED: "The agent's session has expired.",
  RAW_CALL_FORBIDDEN: "Agents can only use approved actions, not arbitrary calls.",
  PRIVILEGE_ESCALATION: "Agents cannot change account ownership, guardians or permissions.",
  WITHDRAW_FORBIDDEN: "Agents cannot withdraw your savings.",
  ACTION_NOT_ALLOWED: "This action isn't allowed for this agent.",
  TARGET_NOT_ALLOWED: "That destination isn't approved.",
  RECIPIENT_NOT_ALLOWED: "That recipient isn't on the agent's allowlist.",
  PRICE_UNAVAILABLE: "No trusted price is available, so agent spending is blocked.",
  PER_CALL_CAP_EXCEEDED: "Above the agent's per-payment limit.",
  DAILY_CAP_EXCEEDED: "Above the agent's daily limit.",
  INTENT_EXPIRED: "This approval expired. Try again.",
  INTENT_REPLAYED: "This approval was already used.",
  SIGNATURE_INVALID: "The signature doesn't match this account.",
  SWAP_UNDERDELIVERED: "The swap would deliver less than requested, so nothing was paid.",
  SPONSOR_BUDGET_EXCEEDED: "Sponsored fees are used up for today.",
  SPONSOR_USER_BUDGET_EXCEEDED: "You've used today's sponsored fee allowance.",
  SPONSOR_RATE_LIMITED: "Too many requests — wait a minute.",
  SPONSOR_NOT_CONFIGURED: "The fee sponsor isn't configured on this deployment.",
};

export function ReceiptCard({ receipt, auditError }: { receipt: ReceiptJson; auditError?: string | null }) {
  const ok = receipt.status === "success";
  const tx = (receipt.transactionId as string | null) ?? (receipt.transactionHash as string | null);
  return (
    <div className={`alert ${ok ? "alert-success" : "alert-error"} flex flex-col items-start gap-1 text-sm`}>
      <span className="font-semibold">
        {ok
          ? receipt.mirror?.status === "verified"
            ? "Done — confirmed on Hedera"
            : "Submitted — awaiting Mirror Node confirmation"
          : "Not allowed"}
      </span>
      {!ok && receipt.reasonCode ? (
        <span>
          {REASON_COPY[receipt.reasonCode] ?? receipt.detail} <code className="opacity-70">{receipt.reasonCode}</code>
          {receipt.deniedBy ? <span className="opacity-70"> · decided by {receipt.deniedBy}</span> : null}
        </span>
      ) : null}
      {tx ? (
        <a className="link" href={hashscanTx(tx)} target="_blank" rel="noreferrer">
          View on HashScan
        </a>
      ) : null}
      {receipt.hcsAudit ? (
        <span className="opacity-80">
          Audit record: topic {receipt.hcsAudit.topicId} #{receipt.hcsAudit.sequenceNumber}
        </span>
      ) : null}
      {auditError ? <span className="opacity-80">{auditError}</span> : null}
    </div>
  );
}
