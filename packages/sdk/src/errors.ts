import { type Hex, BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem";
import { consumerAccountAbi } from "./abi";

/** Policy reason codes surfaced to users, MCP clients and HCS audit records. */
export const REASON_CODES = [
  "SESSION_EXPIRED",
  "RAW_CALL_FORBIDDEN",
  "PRIVILEGE_ESCALATION",
  "WITHDRAW_FORBIDDEN",
  "ACTION_NOT_ALLOWED",
  "TARGET_NOT_ALLOWED",
  "SELECTOR_NOT_ALLOWED",
  "RECIPIENT_NOT_ALLOWED",
  "PRICE_UNAVAILABLE",
  "PER_CALL_CAP_EXCEEDED",
  "DAILY_CAP_EXCEEDED",
  "INTENT_EXPIRED",
  "INTENT_REPLAYED",
  "SIGNATURE_INVALID",
  // Non-policy failures
  "HTS_CALL_FAILED",
  "SWAP_UNDERDELIVERED",
  "SWAP_OVERSPENT",
  "SWAP_PATH_MISMATCH",
  "CALL_FAILED",
  "NOT_SELF",
  "INVALID_CONFIG",
  "UNKNOWN_REVERT",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const ERROR_TO_REASON: Record<string, ReasonCode> = {
  SessionExpired: "SESSION_EXPIRED",
  RawCallForbidden: "RAW_CALL_FORBIDDEN",
  PrivilegeEscalation: "PRIVILEGE_ESCALATION",
  WithdrawForbidden: "WITHDRAW_FORBIDDEN",
  ActionNotAllowed: "ACTION_NOT_ALLOWED",
  TargetNotAllowed: "TARGET_NOT_ALLOWED",
  RecipientNotAllowed: "RECIPIENT_NOT_ALLOWED",
  PriceUnavailable: "PRICE_UNAVAILABLE",
  PerCallCapExceeded: "PER_CALL_CAP_EXCEEDED",
  DailyCapExceeded: "DAILY_CAP_EXCEEDED",
  IntentExpired: "INTENT_EXPIRED",
  IntentReplayed: "INTENT_REPLAYED",
  SignatureInvalid: "SIGNATURE_INVALID",
  ECDSAInvalidSignature: "SIGNATURE_INVALID",
  ECDSAInvalidSignatureLength: "SIGNATURE_INVALID",
  ECDSAInvalidSignatureS: "SIGNATURE_INVALID",
  HtsCallFailed: "HTS_CALL_FAILED",
  HtsCallMustBeTyped: "TARGET_NOT_ALLOWED",
  SwapUnderdelivered: "SWAP_UNDERDELIVERED",
  SwapOverspent: "SWAP_OVERSPENT",
  SwapPathMismatch: "SWAP_PATH_MISMATCH",
  CallFailed: "CALL_FAILED",
  NotSelf: "NOT_SELF",
  InvalidConfig: "INVALID_CONFIG",
};

export type DecodedRevert = { reason: ReasonCode; errorName: string | null; args: readonly unknown[] };

/** Decodes ConsumerAccount revert data into a reason code. Nested CallFailed payloads are unwrapped. */
export function decodeRevertData(data: Hex | undefined): DecodedRevert {
  if (!data || data === "0x") return { reason: "UNKNOWN_REVERT", errorName: null, args: [] };
  try {
    const { errorName, args = [] } = decodeErrorResult({ abi: consumerAccountAbi, data });
    if (errorName === "CallFailed") {
      const inner = decodeRevertData(args[1] as Hex);
      if (inner.reason !== "UNKNOWN_REVERT") return inner;
    }
    return { reason: ERROR_TO_REASON[errorName] ?? "UNKNOWN_REVERT", errorName, args };
  } catch {
    return { reason: "UNKNOWN_REVERT", errorName: null, args: [] };
  }
}

/** Extracts a reason code from a viem error thrown by simulateContract / writeContract. */
export function reasonFromError(err: unknown): DecodedRevert {
  if (err instanceof BaseError) {
    const reverted = err.walk(e => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.raw) return decodeRevertData(reverted.raw);
      const name = reverted.data?.errorName;
      if (name) return { reason: ERROR_TO_REASON[name] ?? "UNKNOWN_REVERT", errorName: name, args: reverted.data?.args ?? [] };
    }
    const withData = err.walk(e => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
    if (withData?.data) return decodeRevertData(withData.data);
  }
  return { reason: "UNKNOWN_REVERT", errorName: null, args: [] };
}
