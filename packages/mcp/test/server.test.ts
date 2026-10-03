import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type Hex, getAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SESSION_ACTION_TYPES, consumerAccountDomain, sponsorRequestSchema } from "@sh/sdk";
import { createConsumerMcpServer } from "../src/server";

const account = getAddress("0x035dfc0c1c501c5aed26796fe8756ea4f617cd94");

async function connect(fetchImpl: typeof fetch) {
  const agent = privateKeyToAccount(generatePrivateKey());
  const server = createConsumerMcpServer({ account, agent, appUrl: "http://app.test", fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, agent };
}

describe("consumer-account MCP server", () => {
  it("exposes the four agent tools with read-only hints where appropriate", async () => {
    const { client } = await connect(fetch);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["fetch_paid_resource", "get_allowance", "get_audit_log", "pay"]);
    expect(tools.find(t => t.name === "get_allowance")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === "pay")?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("pay signs a typed session action with the agent key and surfaces on-chain denials", async () => {
    let posted: unknown;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://app.test/api/sponsor");
      posted = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          receipt: {
            status: "denied",
            reasonCode: "PER_CALL_CAP_EXCEEDED",
            deniedBy: "account-contract",
            detail: "PerCallCapExceeded",
            hcsAudit: { topicId: "0.0.1", sequenceNumber: 7 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { client, agent } = await connect(fetchImpl);
    const res = await client.callTool({
      name: "pay",
      arguments: { to: "0x1111111111111111111111111111111111111111", amount: "20", asset: "HBAR" },
    });
    expect(res.isError).toBe(true);
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out).toMatchObject({ status: "denied", reasonCode: "PER_CALL_CAP_EXCEEDED", deniedBy: "account-contract" });

    // The request is a well-formed session action signed by the agent's session key (not an owner intent).
    const req = sponsorRequestSchema.parse(posted);
    expect(req.kind).toBe("session-action");
    if (req.kind !== "session-action") return;
    const signer = await recoverTypedDataAddress({
      domain: consumerAccountDomain(296, account),
      types: SESSION_ACTION_TYPES,
      primaryType: "SessionAction",
      message: {
        actionId: req.action.actionId as Hex,
        actionData: req.action.actionData as Hex,
        nonce: BigInt(req.action.nonce),
        validUntil: BigInt(req.action.validUntil),
      },
      signature: req.signature as Hex,
    });
    expect(signer).toBe(agent.address);
  });

  it("rejects malformed amounts before signing anything", async () => {
    const { client } = await connect((async () => {
      throw new Error("must not be called");
    }) as typeof fetch);
    const res = await client.callTool({ name: "pay", arguments: { to: "0.0.5", amount: "-1" } });
    expect(res.isError).toBe(true);
  });
});
