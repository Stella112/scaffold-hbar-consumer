# MCP server

`packages/mcp` gives an AI client tools backed by one ConsumerAccount. It holds only a **session key**; every spend
is a typed session action the account checks on-chain, and denials return their reason code to the model.

```bash
CONSUMER_ACCOUNT=0x… AGENT_PRIVATE_KEY=0x… CONSUMER_APP_URL=https://your-app yarn mcp:start
```

| Tool | Does |
| --- | --- |
| `get_balance` | HBAR, tokens, savings |
| `get_policy` | caps, spent today, expiry, recipient restriction, live HBAR/USD |
| `get_sponsor_status` | whether fees can be sponsored |
| `create_payment` | sponsored payment (HBAR/USDC/WHBAR) to `0.0.x` or `0x…` |
| `create_payment_request` | signed link for someone to pay the account |
| `swap_and_pay` | SaucerSwap exact-output payment |
| `purchase_x402` | fetch an x402 resource, paying within a client-side HBAR cap |
| `deposit_vault` | deposit into the savings vault |
| `get_receipt` | Mirror Node record for a transaction |
| `get_audit_log` | HCS policy decisions for the account |

There is no arbitrary-call tool. Testnet flow 7 drives the server with a real MCP client against the deployed app.
