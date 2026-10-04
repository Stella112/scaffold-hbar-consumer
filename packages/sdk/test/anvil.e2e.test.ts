/**
 * End-to-end against a local Anvil chain and the real compiled contracts (no Hedera system contracts).
 * Proves the SDK's EIP-712 signatures are accepted on-chain and that a zero-balance controller can act through
 * a sponsor. Skipped when `anvil` is not installed. Local evidence only — never used for testnet claims.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { accountCodeChunks } from "../src/factoryCode";
import { consumerAccountAbi, consumerAccountFactoryAbi, consumerAccountFactoryBytecode } from "../src/abi";
import { ACTION_IDS, HBAR, RESERVED_ACTION_IDS, encodePayment } from "../src/actions";
import { encodeCreateAccount, encodeExecuteOwnerIntent, selfCall } from "../src/account";
import { reasonFromError } from "../src/errors";
import { buildOwnerIntent, buildSessionAction, signOwnerIntent, signSessionAction } from "../src/intent";

const PORT = 8555;
const RPC = `http://127.0.0.1:${PORT}`;
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
// Anvil's first default dev key, used as the local sponsor.
const SPONSOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

describe.skipIf(!hasAnvil)("anvil e2e: sponsored ConsumerAccount", () => {
  let anvil: ChildProcess;
  const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const sponsor = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(SPONSOR_PK) });
  const controller = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  let factory: Address;
  let account: Address;

  const send = async (to: Address, data: Hex) => {
    const hash = await sponsor.sendTransaction({ to, data });
    return publicClient.waitForTransactionReceipt({ hash });
  };

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
    // ConsumerAccount's creation code goes into data-contract chunks; the factory reassembles it.
    const { chunks, codeHash } = accountCodeChunks();
    const chunkAddresses: `0x${string}`[] = [];
    for (const data of chunks) {
      const h = await sponsor.sendTransaction({ data });
      chunkAddresses.push((await publicClient.waitForTransactionReceipt({ hash: h })).contractAddress as `0x${string}`);
    }
    const hash = await sponsor.deployContract({
      abi: consumerAccountFactoryAbi,
      bytecode: consumerAccountFactoryBytecode,
      args: [chunkAddresses, codeHash, HBAR],
    });
    factory = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    await send(factory, encodeCreateAccount(controller.address, zeroHash));
    account = await publicClient.readContract({
      address: factory,
      abi: consumerAccountFactoryAbi,
      functionName: "getAddress",
      args: [controller.address, zeroHash],
    });
    await sponsor.sendTransaction({ to: account, value: parseEther("5") });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("controller with zero balance pays through the sponsor", async () => {
    expect(await publicClient.getBalance({ address: controller.address })).toBe(0n);
    const intent = buildOwnerIntent([{ target: merchant, value: parseEther("1"), data: "0x" }]);
    const sig = await signOwnerIntent(controller, chain.id, account, intent);
    const receipt = await send(account, encodeExecuteOwnerIntent(intent, sig));
    expect(receipt.status).toBe("success");
    expect(await publicClient.getBalance({ address: merchant })).toBe(parseEther("1"));
    expect(await publicClient.getBalance({ address: controller.address })).toBe(0n);
  });

  it("session typed action fails closed without an oracle, and raw calls are forbidden", async () => {
    const grant = buildOwnerIntent([
      selfCall.grantSession(account, {
        key: agent.address,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
        perCallCapUsd6: 1_000_000n,
        dailyCapUsd6: 5_000_000n,
        allowedActions: [ACTION_IDS.payment],
        allowedRecipients: [],
      }),
    ]);
    await send(account, encodeExecuteOwnerIntent(grant, await signOwnerIntent(controller, chain.id, account, grant)));

    const pay = buildSessionAction(ACTION_IDS.payment, encodePayment({ asset: HBAR, to: merchant, amount: 1n }));
    const paySig = await signSessionAction(agent, chain.id, account, pay);
    await expect(
      publicClient.simulateContract({
        address: account,
        abi: consumerAccountAbi,
        functionName: "executeSessionAction",
        args: [pay, paySig],
        account: sponsor.account,
      }),
    ).rejects.toSatisfy((e: unknown) => reasonFromError(e).reason === "PRICE_UNAVAILABLE");

    const raw = buildOwnerIntent([{ target: merchant, value: 1n, data: "0x" }]);
    const rawSig = await signOwnerIntent(agent, chain.id, account, raw);
    await expect(
      publicClient.simulateContract({
        address: account,
        abi: consumerAccountAbi,
        functionName: "executeOwnerIntent",
        args: [raw, rawSig],
        account: sponsor.account,
      }),
    ).rejects.toSatisfy((e: unknown) => reasonFromError(e).reason === "RAW_CALL_FORBIDDEN");

    const escalate = buildSessionAction(RESERVED_ACTION_IDS.adminSetOwner, "0x");
    const escSig = await signSessionAction(agent, chain.id, account, escalate);
    await expect(
      publicClient.simulateContract({
        address: account,
        abi: consumerAccountAbi,
        functionName: "executeSessionAction",
        args: [escalate, escSig],
        account: sponsor.account,
      }),
    ).rejects.toSatisfy((e: unknown) => reasonFromError(e).reason === "PRIVILEGE_ESCALATION");
  });

});
