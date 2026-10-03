/**
 * yarn sponsor:fund [HBAR] [--fund]
 *
 * Tops up the sponsor account from the operator. Prints the transfer and sends nothing unless --fund is passed.
 * The sponsor pays every sponsored transaction fee and HCS audit message, so it drains with use.
 */
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { z } from "zod";
import { hederaClient, mirror } from "./lib/clients";
import { operatorEnv, parseEnv } from "./lib/env";

const op = parseEnv(operatorEnv, "sponsor:fund");
const { SPONSOR_ACCOUNT_ID } = parseEnv(
  z.object({ SPONSOR_ACCOUNT_ID: z.string().regex(/^0\.0\.\d+$/) }),
  "sponsor:fund (run `yarn bootstrap --fund` first)",
);
const amountArg = process.argv.slice(2).find(a => /^\d+(\.\d+)?$/.test(a)) ?? "100";
const fund = process.argv.includes("--fund");
const fmt = (t: bigint | number) => `${(Number(t) / 1e8).toFixed(4)} HBAR`;

const m = mirror();
const [opBal, spBal] = await Promise.all([m.getHbarBalance(op.HEDERA_OPERATOR_ID), m.getHbarBalance(SPONSOR_ACCOUNT_ID)]);
console.log(`operator ${op.HEDERA_OPERATOR_ID}: ${fmt(opBal.tinybars)}`);
console.log(`sponsor  ${SPONSOR_ACCOUNT_ID}: ${fmt(spBal.tinybars)}`);
console.log(`\nPlanned: transfer ${amountArg} HBAR operator → sponsor`);
if (!fund) {
  console.log("Nothing was sent. Re-run with `yarn sponsor:fund " + amountArg + " --fund`.");
  process.exit(0);
}
const client = hederaClient(op.HEDERA_OPERATOR_ID, op.HEDERA_OPERATOR_KEY);
try {
  const r = await new TransferTransaction()
    .addHbarTransfer(op.HEDERA_OPERATOR_ID, Hbar.fromString(`-${amountArg}`))
    .addHbarTransfer(SPONSOR_ACCOUNT_ID, Hbar.fromString(amountArg))
    .execute(client);
  await r.getReceipt(client);
  console.log(`PASS transferred ${amountArg} HBAR to sponsor (tx ${r.transactionId.toString()})`);
} finally {
  client.close();
}
