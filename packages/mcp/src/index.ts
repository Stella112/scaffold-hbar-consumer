#!/usr/bin/env -S npx tsx
/**
 * Stdio entry point. Configure in an MCP client (Claude Desktop, Claude Code, …):
 *
 *   CONSUMER_ACCOUNT   ConsumerAccount EVM address (0x…)
 *   AGENT_PRIVATE_KEY  the agent's session key, granted by the owner on the Agent page (never the owner key)
 *   CONSUMER_APP_URL   app base URL with /api/sponsor and /api/x402 (default http://localhost:3000)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConsumerMcpServer } from "./server";

const account = process.env.CONSUMER_ACCOUNT;
const key = process.env.AGENT_PRIVATE_KEY;
if (!account || !isAddress(account) || !key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  // stderr only: stdout carries the MCP protocol.
  console.error("consumer-account-mcp: set CONSUMER_ACCOUNT (0x…) and AGENT_PRIVATE_KEY (session key)");
  process.exit(1);
}

const server = createConsumerMcpServer({
  account: getAddress(account),
  agent: privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`),
  appUrl: process.env.CONSUMER_APP_URL ?? "http://localhost:3000",
  rpcUrl: process.env.HEDERA_RPC_URL,
  mirrorUrl: process.env.MIRROR_NODE_URL,
});
await server.connect(new StdioServerTransport());
