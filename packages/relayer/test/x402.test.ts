import { describe, expect, it } from "vitest";
import { getAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  TRANSFER_AUTHORIZATION_TYPES,
  X402_HEDERA_TESTNET,
  consumerAccountDomain,
  createTransferExecutorPayload,
  decodeTransferAuthorization,
  entityIdToLongZero,
  type MirrorAccount,
  type MirrorTransaction,
  resolveX402PayTo,
} from "@sh/sdk";
import { checkSettlementRecords, toMirrorTransactionId } from "../src/x402";

const rec = (over: Partial<MirrorTransaction>): MirrorTransaction => ({
  transaction_id: "0.0.9-1-1",
  consensus_timestamp: "1.1",
  result: "SUCCESS",
  charged_tx_fee: 1000,
  transfers: [],
  token_transfers: [],
  ...over,
});
const base = { asset: "0.0.0", amount: 500n, payer: "0.0.100", payTo: "0.0.200", feePayer: "0.0.9" };
const feeLegs = [
  { account: "0.0.9", amount: -1000, is_approval: false },
  { account: "0.0.3", amount: 100, is_approval: false },
  { account: "0.0.98", amount: 900, is_approval: false },
];

describe("x402 settlement record conformance", () => {
  it("accepts an exact HBAR transfer split across parent and child records", () => {
    const records = [
      rec({ transfers: feeLegs }),
      rec({
        charged_tx_fee: 0,
        transfers: [
          { account: "0.0.100", amount: -500, is_approval: false },
          { account: "0.0.200", amount: 500, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(records, base)).toEqual({ ok: true });
  });

  it("rejects an under-credit to payTo", () => {
    const records = [
      rec({
        transfers: [
          ...feeLegs,
          { account: "0.0.100", amount: -499, is_approval: false },
          { account: "0.0.200", amount: 499, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(records, base)).toMatchObject({ ok: false, reason: "settlement_nonconforming" });
  });

  it("rejects a third-party debit", () => {
    const records = [
      rec({
        transfers: [
          ...feeLegs,
          { account: "0.0.100", amount: -500, is_approval: false },
          { account: "0.0.200", amount: 600, is_approval: false },
          { account: "0.0.777", amount: -100, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(records, { ...base, amount: 600n })).toMatchObject({ ok: false });
  });

  it("rejects a failed record even if transfers look right", () => {
    const records = [
      rec({
        result: "CONTRACT_REVERT_EXECUTED",
        transfers: [...feeLegs, { account: "0.0.100", amount: -500, is_approval: false }, { account: "0.0.200", amount: 500, is_approval: false }],
      }),
    ];
    expect(checkSettlementRecords(records, base)).toMatchObject({ ok: false });
  });

  it("rejects fee payer debits beyond the charged fee", () => {
    const records = [
      rec({
        transfers: [
          { account: "0.0.9", amount: -5000, is_approval: false },
          { account: "0.0.98", amount: 5000, is_approval: false },
          { account: "0.0.100", amount: -500, is_approval: false },
          { account: "0.0.200", amount: 500, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(records, base)).toMatchObject({ ok: false });
  });

  it("checks token transfers and forbids other token movement", () => {
    const tok = { ...base, asset: "0.0.5449", amount: 100_000n };
    const ok = [
      rec({
        transfers: feeLegs,
        token_transfers: [
          { token_id: "0.0.5449", account: "0.0.100", amount: -100_000, is_approval: false },
          { token_id: "0.0.5449", account: "0.0.200", amount: 100_000, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(ok, tok)).toEqual({ ok: true });
    const extra = [
      rec({
        transfers: feeLegs,
        token_transfers: [
          ...ok[0]!.token_transfers,
          { token_id: "0.0.15058", account: "0.0.100", amount: -1, is_approval: false },
          { token_id: "0.0.15058", account: "0.0.200", amount: 1, is_approval: false },
        ],
      }),
    ];
    expect(checkSettlementRecords(extra, tok)).toMatchObject({ ok: false });
  });
});

// Stub Mirror Node: the merchant has an EVM alias; 0.0.1 does not.
const MERCHANT_ALIAS = "0x1111111111111111111111111111111111111111";
const stubMirror = {
  getAccount: async (id: string) =>
    ({ account: id, evm_address: id === "0.0.10841388" ? MERCHANT_ALIAS : null }) as unknown as MirrorAccount,
};

describe("x402 helpers", () => {
  it("resolves payTo to the EVM alias when present, else long-zero", async () => {
    expect(await resolveX402PayTo(stubMirror, "0.0.10841388")).toBe(getAddress(MERCHANT_ALIAS));
    expect(await resolveX402PayTo(stubMirror, "0.0.1")).toBe(entityIdToLongZero("0.0.1"));
  });

  it("converts SDK transaction ids to Mirror Node form", () => {
    expect(toMirrorTransactionId("0.0.123@1700000000.000000001")).toBe("0.0.123-1700000000-000000001");
  });

  it("client payload binds exactly the requirement fields and recovers to the signer", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const account = getAddress("0x035dfc0c1c501c5aed26796fe8756ea4f617cd94");
    const requirements = {
      scheme: "exact",
      network: X402_HEDERA_TESTNET as `${string}:${string}`,
      asset: "0.0.0",
      amount: "5000000",
      payTo: "0.0.10841388",
      maxTimeoutSeconds: 120,
      extra: { assetTransferMethod: "transferExecutor", executors: ["0.0.4242"] },
    };
    const p = await createTransferExecutorPayload({
      signer,
      chainId: 296,
      account,
      accountId: "0.0.4242",
      requirements,
      mirror: stubMirror,
    });
    expect(p.payer).toBe("0.0.4242");
    expect(p.executor).toBe("0.0.4242");
    const d = decodeTransferAuthorization(p.authorization);
    const recovered = await recoverTypedDataAddress({
      domain: consumerAccountDomain(296, account),
      types: TRANSFER_AUTHORIZATION_TYPES,
      primaryType: "TransferAuthorization",
      message: {
        from: account,
        asset: "0x0000000000000000000000000000000000000000",
        to: getAddress(MERCHANT_ALIAS),
        amount: 5_000_000n,
        nonce: d.nonce,
        validUntil: d.validUntil,
      },
      signature: d.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("client refuses an executor the resource did not admit", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    await expect(
      createTransferExecutorPayload({
        signer,
        chainId: 296,
        account: getAddress("0x035dfc0c1c501c5aed26796fe8756ea4f617cd94"),
        accountId: "0.0.4242",
        mirror: stubMirror,
        requirements: {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.0",
          amount: "1",
          payTo: "0.0.1",
          maxTimeoutSeconds: 60,
          extra: { assetTransferMethod: "transferExecutor", executors: [] },
        },
      }),
    ).rejects.toThrow(/not admitted/);
  });
});
