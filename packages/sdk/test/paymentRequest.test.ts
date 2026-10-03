import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HBAR } from "../src/actions";
import { entityIdToLongZero } from "../src/hedera";
import {
  type PaymentRequest,
  decodePaymentRequest,
  encodePaymentRequest,
  signPaymentRequest,
  verifyPaymentRequest,
} from "../src/paymentRequest";

const merchant = privateKeyToAccount(generatePrivateKey());
const now = 1_800_000_000;
const base: PaymentRequest = {
  chainId: 296,
  recipient: merchant.address,
  asset: entityIdToLongZero("0.0.5449"),
  amount: 10_000_000n,
  memo: "Coffee ☕",
  expiresAt: BigInt(now + 600),
  referenceId: "order-42",
};

describe("payment requests", () => {
  it("round-trips through the QR/link encoding and verifies", async () => {
    const signed = await signPaymentRequest(merchant, base);
    const decoded = decodePaymentRequest(encodePaymentRequest(signed));
    expect(decoded).toEqual(signed);
    expect(await verifyPaymentRequest(decoded, { chainId: 296, nowSeconds: now })).toMatchObject({
      valid: true,
      signerRole: "recipient",
    });
  });

  it("detects amount and recipient tampering", async () => {
    const signed = await signPaymentRequest(merchant, base);
    const amount = { ...signed, request: { ...signed.request, amount: 1n } };
    const recipient = { ...signed, request: { ...signed.request, recipient: privateKeyToAccount(generatePrivateKey()).address } };
    expect(await verifyPaymentRequest(amount, { chainId: 296, nowSeconds: now })).toEqual({
      valid: false,
      reason: "SIGNER_NOT_RECIPIENT",
    });
    expect(await verifyPaymentRequest(recipient, { chainId: 296, nowSeconds: now })).toEqual({
      valid: false,
      reason: "SIGNER_NOT_RECIPIENT",
    });
  });

  it("rejects expired and wrong-network requests", async () => {
    const signed = await signPaymentRequest(merchant, { ...base, asset: HBAR });
    expect(await verifyPaymentRequest(signed, { chainId: 296, nowSeconds: now + 601 })).toEqual({
      valid: false,
      reason: "EXPIRED",
    });
    expect(await verifyPaymentRequest(signed, { chainId: 295, nowSeconds: now })).toEqual({
      valid: false,
      reason: "WRONG_NETWORK",
    });
  });

  it("rejects garbage payloads", () => {
    expect(() => decodePaymentRequest("not-a-request")).toThrow();
  });
});
