import http from "node:http";
import { MirrorClient, receiptToJson } from "@sh/sdk";
import { loadRelayerConfig } from "./config";
import { createTestnetSponsor } from "./factory";

/**
 * Standalone sponsor relayer for hosts with persistent processes.
 *   POST /v1/sponsor   body: SponsorRequest   → { receipt, auditError }
 *   GET  /v1/status    sponsor balance (Mirror Node) + local spend counters
 *   GET  /v1/receipts  recent receipts (local operational data)
 */
const cfg = loadRelayerConfig();
const { sponsor, store } = createTestnetSponsor(cfg);
const mirror = new MirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });
const MAX_BODY = 64 * 1024;

const send = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/v1/status") {
      const bal = await mirror.getHbarBalance(cfg.SPONSOR_ACCOUNT_ID);
      return send(
        res,
        200,
        JSON.stringify({
          source: { balance: "mirror-node", spend: "local-operational-metrics" },
          sponsorAccountId: cfg.SPONSOR_ACCOUNT_ID,
          balanceTinybars: bal.tinybars.toString(),
          day: store.spend.day,
          spentTodayTinybars: store.spend.totalTinybars.toString(),
          dailyBudgetTinybars: cfg.SPONSOR_DAILY_BUDGET_HBAR.toString(),
          perUserDailyTinybars: cfg.SPONSOR_PER_USER_DAILY_HBAR.toString(),
          auditTopicId: cfg.HCS_AUDIT_TOPIC_ID ?? null,
        }),
      );
    }
    if (req.method === "GET" && req.url === "/v1/receipts") {
      return send(res, 200, JSON.stringify(store.recentReceipts()));
    }
    if (req.method === "POST" && req.url === "/v1/sponsor") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return send(res, 413, JSON.stringify({ error: "body too large" }));
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return send(res, 400, JSON.stringify({ error: "invalid JSON" }));
      }
      const result = await sponsor.handle(json);
      const status = result.receipt.status === "success" ? 200 : 422;
      return send(res, status, `{"receipt":${receiptToJson(result.receipt)},"auditError":${JSON.stringify(result.auditError)}}`);
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    // Never echo internals that could include configuration.
    console.error("relayer error:", (e as Error).message);
    send(res, 500, JSON.stringify({ error: "internal error" }));
  }
});

server.listen(cfg.RELAYER_PORT, () => {
  console.log(`sponsor relayer listening on :${cfg.RELAYER_PORT} (sponsor ${cfg.SPONSOR_ACCOUNT_ID})`);
});
