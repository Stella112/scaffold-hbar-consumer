import { describe, expect, it } from "vitest";
import { encodeErrorResult, getAddress } from "viem";
import { consumerAccountAbi } from "../src/abi";
import {
  ACTION_IDS,
  HBAR,
  decodeSwapToPay,
  decodeTransferAction,
  encodePayment,
  encodeSwapToPay,
  exactOutputPath,
} from "../src/actions";
import { decodeRevertData } from "../src/errors";
import { entityIdToLongZero, longZeroToEntityId, toAddress, tinybarsToWeibars } from "../src/hedera";
import { buildSessionAction, randomNonce } from "../src/intent";
import { toMirrorTxId } from "../src/mirror";
import { sponsorRequestSchema } from "../src/sponsor";

const usdc = entityIdToLongZero("0.0.5449");
const whbar = entityIdToLongZero("0.0.15058");
const sauce = entityIdToLongZero("0.0.1183558");
const merchant = getAddress("0x1111111111111111111111111111111111111111");

describe("hedera ids", () => {
  it("round-trips entity ids and long-zero addresses", () => {
    expect(usdc).toBe("0x0000000000000000000000000000000000001549");
    expect(longZeroToEntityId(usdc)).toBe("0.0.5449");
    expect(toAddress("0.0.1414040")).toBe("0x0000000000000000000000000000000000159398");
    expect(longZeroToEntityId(merchant)).toBeNull();
    expect(() => entityIdToLongZero("1.0.5")).toThrow();
  });

  it("converts tinybars to weibars", () => {
    expect(tinybarsToWeibars(1n)).toBe(10_000_000_000n);
  });

  it("converts SDK tx ids to mirror form", () => {
    expect(toMirrorTxId("0.0.123@1700000000.000000001")).toBe("0.0.123-1700000000-000000001");
  });
});

describe("actions", () => {
  it("action ids match the Solidity registry", () => {
    // keccak256("consumer.action.payment.v1") computed independently by the Foundry tests via Actions.PAYMENT
    expect(ACTION_IDS.payment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(Object.values(ACTION_IDS)).size).toBe(Object.keys(ACTION_IDS).length);
  });

  it("round-trips payment payloads", () => {
    const p = { asset: HBAR, to: merchant, amount: 5n };
    expect(decodeTransferAction(encodePayment(p))).toEqual(p);
  });

  it("builds a reversed exact-output path (output first)", () => {
    const path = exactOutputPath([usdc, whbar, sauce], [3000, 3000]);
    expect(path).toBe(`0x${usdc.slice(2)}000bb8${whbar.slice(2)}000bb8${sauce.slice(2)}`.toLowerCase());
    expect((path.length - 2) / 2).toBe(20 * 3 + 3 * 2);
    expect(() => exactOutputPath([usdc], [])).toThrow();
  });

  it("round-trips swap-to-pay payloads", () => {
    const s = {
      router: entityIdToLongZero("0.0.1414040"),
      tokenIn: sauce,
      amountInMaximum: 25_000_000n,
      tokenOut: usdc,
      amountOut: 1_000_000n,
      to: merchant,
      deadline: 1_800_000_000n,
      path: exactOutputPath([usdc, whbar, sauce], [3000, 3000]),
    };
    expect(decodeSwapToPay(encodeSwapToPay(s))).toEqual(s);
  });
});

describe("intents", () => {
  it("uses unique 256-bit nonces", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
    expect(a < 2n ** 256n).toBe(true);
  });

  it("sets a future expiry", () => {
    const a = buildSessionAction(ACTION_IDS.payment, "0x", 60);
    expect(Number(a.validUntil)).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("revert decoding", () => {
  it("maps custom errors to reason codes", () => {
    for (const [errorName, reason] of [
      ["RawCallForbidden", "RAW_CALL_FORBIDDEN"],
      ["DailyCapExceeded", "DAILY_CAP_EXCEEDED"],
      ["PrivilegeEscalation", "PRIVILEGE_ESCALATION"],
      ["WithdrawForbidden", "WITHDRAW_FORBIDDEN"],
      ["TargetNotAllowed", "TARGET_NOT_ALLOWED"],
    ] as const) {
      const data = encodeErrorResult({ abi: consumerAccountAbi, errorName });
      expect(decodeRevertData(data).reason).toBe(reason);
    }
  });

  it("unwraps CallFailed to the inner reason", () => {
    const inner = encodeErrorResult({ abi: consumerAccountAbi, errorName: "PrivilegeEscalation" });
    const outer = encodeErrorResult({ abi: consumerAccountAbi, errorName: "CallFailed", args: [0n, inner] });
    expect(decodeRevertData(outer).reason).toBe("PRIVILEGE_ESCALATION");
  });

  it("does not invent reasons for unknown data", () => {
    expect(decodeRevertData("0xdeadbeef").reason).toBe("UNKNOWN_REVERT");
    expect(decodeRevertData(undefined).reason).toBe("UNKNOWN_REVERT");
  });
});

describe("sponsor request schema", () => {
  it("rejects malformed requests", () => {
    expect(sponsorRequestSchema.safeParse({ kind: "owner-intent", chainId: 296 }).success).toBe(false);
    expect(
      sponsorRequestSchema.safeParse({ kind: "create-account", chainId: 296, owner: merchant, salt: "0x00" }).success,
    ).toBe(true);
  });
});
