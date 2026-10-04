/**
 * Sponsor pipeline against a local Anvil chain with the real compiled contracts.
 * Local verification only: no Mirror Node and no HCS here (a recording auditor stands in).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Address, type Hex, createPublicClient, createWalletClient, http, parseEther, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  ACTION_IDS,
  HBAR,
  RESERVED_ACTION_IDS,
  buildOwnerIntent,
  buildSessionAction,
  consumerAccountAbi,
  consumerAccountFactoryAbi,
  consumerAccountBytecode,
  consumerAccountFactoryBytecode,
  encodePayment,
  selfCall,
  signOwnerIntent,
  signSessionAction,
  toSponsorRequest,
} from "@sh/sdk";
import type { AuditRecord, Auditor } from "../src/audit";
import { Sponsor } from "../src/sponsor";
import { RelayerStore } from "../src/store";

const PORT = 8556;
const RPC = `http://127.0.0.1:${PORT}`;
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const SPONSOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/** Test-only auditor that records instead of writing to HCS. */
class RecordingAuditor implements Auditor {
  readonly topicId = "0.0.0-test";
  records: AuditRecord[] = [];
  async submit(r: AuditRecord) {
    this.records.push(r);
    return { topicId: this.topicId, sequenceNumber: this.records.length, transactionId: "local", consensusTimestamp: null };
  }
}

describe.skipIf(!hasAnvil)("sponsor pipeline (anvil)", () => {
  let anvil: ChildProcess;
  const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const walletClient = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(SPONSOR_PK) });
  const controller = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const auditor = new RecordingAuditor();
  let sponsor: Sponsor;
  let factory: Address;
  let account: Address;

  const make = (limits = { dailyBudgetTinybars: 10n ** 30n, perUserDailyTinybars: 10n ** 30n, ratePerMinute: 100 }) =>
    new Sponsor({
      publicClient,
      walletClient,
      chainId: chain.id,
      factory,
      sponsorAccountId: "local-sponsor",
      limits,
      store: new RelayerStore(null),
      mirror: null,
      auditor,
    });

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"]);
    for (let i = 0; i < 50; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    // Account implementation first; the factory deploys EIP-1167 clones of it.
    const implHash = await walletClient.deployContract({ abi: consumerAccountAbi, bytecode: consumerAccountBytecode, args: [] });
    const implementation = (await publicClient.waitForTransactionReceipt({ hash: implHash })).contractAddress!;
    const hash = await walletClient.deployContract({
      abi: consumerAccountFactoryAbi,
      bytecode: consumerAccountFactoryBytecode,
      args: [implementation, HBAR],
    });
    factory = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    sponsor = make();
  }, 30_000);

  afterAll(() => anvil?.kill());

  it("sponsors account creation for a zero-balance controller", async () => {
    const { receipt } = await sponsor.handle(toSponsorRequest.createAccount(chain.id, controller.address, zeroHash));
    expect(receipt.status).toBe("success");
    account = await publicClient.readContract({
      address: factory,
      abi: consumerAccountFactoryAbi,
      functionName: "getAddress",
      args: [controller.address, zeroHash],
    });
    expect(receipt.account).toBe(account);
    await walletClient.sendTransaction({ to: account, value: parseEther("3") });
    expect(await publicClient.getBalance({ address: controller.address })).toBe(0n);
  });

  it("executes an owner-signed payment and audits it", async () => {
    const intent = buildOwnerIntent([{ target: merchant, value: parseEther("1"), data: "0x" }]);
    const sig = await signOwnerIntent(controller, chain.id, account, intent);
    const { receipt } = await sponsor.handle(toSponsorRequest.ownerIntent(chain.id, account, intent, sig));
    expect(receipt.status).toBe("success");
    if (receipt.status !== "success") return;
    expect(receipt.actorType).toBe("owner");
    expect(receipt.mirror.status).toBe("pending"); // no Mirror Node locally; never claimed as verified
    expect(await publicClient.getBalance({ address: merchant })).toBe(parseEther("1"));
    expect(auditor.records.at(-1)).toMatchObject({ allowed: true, actorType: "owner" });

    const dup = await sponsor.handle(toSponsorRequest.ownerIntent(chain.id, account, intent, sig));
    expect(dup.receipt.status === "denied" && dup.receipt.reasonCode).toBe("SPONSOR_DUPLICATE_REQUEST");
  });

  it("rejects wrong network and short-lived intents", async () => {
    const intent = buildOwnerIntent([{ target: merchant, value: 1n, data: "0x" }], 2);
    const sig = await signOwnerIntent(controller, chain.id, account, intent);
    const wrong = await sponsor.handle(toSponsorRequest.ownerIntent(296, account, intent, sig));
    expect(wrong.receipt.status === "denied" && wrong.receipt.reasonCode).toBe("SPONSOR_WRONG_NETWORK");
    const expired = await sponsor.handle(toSponsorRequest.ownerIntent(chain.id, account, intent, sig));
    expect(expired.receipt.status === "denied" && expired.receipt.reasonCode).toBe("SPONSOR_REQUEST_EXPIRED");
  });

  it("a session raw call is denied by the account contract and audited as a denial", async () => {
    const grant = buildOwnerIntent([
      selfCall.grantSession(account, {
        key: agent.address,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
        perCallCapUsd6: 1_000_000n,
        dailyCapUsd6: 5_000_000n,
        allowedActions: [ACTION_IDS.payment],
        allowedRecipients: [merchant],
      }),
    ]);
    const g = await sponsor.handle(
      toSponsorRequest.ownerIntent(chain.id, account, grant, await signOwnerIntent(controller, chain.id, account, grant)),
    );
    expect(g.receipt.status).toBe("success");

    const raw = buildOwnerIntent([{ target: merchant, value: parseEther("1"), data: "0x" }]);
    const { receipt } = await sponsor.handle(
      toSponsorRequest.ownerIntent(chain.id, account, raw, await signOwnerIntent(agent, chain.id, account, raw)),
    );
    expect(receipt.status).toBe("denied");
    if (receipt.status !== "denied") return;
    expect(receipt.reasonCode).toBe("RAW_CALL_FORBIDDEN");
    expect(receipt.deniedBy).toBe("account-contract");
    expect(receipt.actorType).toBe("session");
    expect(auditor.records.at(-1)).toMatchObject({ allowed: false, reasonCode: "RAW_CALL_FORBIDDEN", actor: agent.address });

    const esc = buildSessionAction(RESERVED_ACTION_IDS.adminSetOwner, "0x");
    const e = await sponsor.handle(
      toSponsorRequest.sessionAction(chain.id, account, esc, await signSessionAction(agent, chain.id, account, esc)),
    );
    expect(e.receipt.status === "denied" && e.receipt.reasonCode).toBe("PRIVILEGE_ESCALATION");

    const pay = buildSessionAction(ACTION_IDS.payment, encodePayment({ asset: HBAR, to: merchant, amount: 1n }));
    const p = await sponsor.handle(
      toSponsorRequest.sessionAction(chain.id, account, pay, await signSessionAction(agent, chain.id, account, pay)),
    );
    // No oracle configured on this local factory: unpriceable session spend fails closed.
    expect(p.receipt.status === "denied" && p.receipt.reasonCode).toBe("PRICE_UNAVAILABLE");
  });

  it("refuses to sponsor once the sponsor budget is exhausted", async () => {
    const broke = make({ dailyBudgetTinybars: 1n, perUserDailyTinybars: 1n, ratePerMinute: 100 });
    const intent = buildOwnerIntent([{ target: merchant, value: 1n, data: "0x" }]);
    const sig = await signOwnerIntent(controller, chain.id, account, intent);
    const { receipt } = await broke.handle(toSponsorRequest.ownerIntent(chain.id, account, intent, sig));
    expect(receipt.status === "denied" && receipt.reasonCode).toBe("SPONSOR_BUDGET_EXCEEDED");
  });

  it("does not sponsor contracts outside its factory", async () => {
    const intent = buildOwnerIntent([{ target: merchant, value: 1n, data: "0x" }]);
    const sig = await signOwnerIntent(controller, chain.id, merchant, intent);
    const { receipt } = await sponsor.handle(toSponsorRequest.ownerIntent(chain.id, merchant, intent, sig));
    expect(receipt.status === "denied" && receipt.reasonCode).toBe("SPONSOR_REQUEST_INVALID");
  });
});
