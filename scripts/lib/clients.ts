import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { HEDERA_TESTNET, MirrorClient } from "@sh/sdk";
import { hederaTestnetChain } from "@sh/relayer";
import { hex0x } from "./env";

export const rpcUrl = () => process.env.HEDERA_RPC_URL ?? HEDERA_TESTNET.rpcUrl;
export const chain = () => hederaTestnetChain(rpcUrl());
export const publicClient = () => createPublicClient({ chain: chain(), transport: http(rpcUrl()) });
export const walletFor = (key: string) =>
  createWalletClient({ chain: chain(), transport: http(rpcUrl()), account: privateKeyToAccount(hex0x(key)) });
export const mirror = () => new MirrorClient({ baseUrl: process.env.MIRROR_NODE_URL ?? HEDERA_TESTNET.mirrorUrl });

export function hederaClient(accountId: string, key: string): Client {
  return Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(key.replace(/^0x/, "")));
}
