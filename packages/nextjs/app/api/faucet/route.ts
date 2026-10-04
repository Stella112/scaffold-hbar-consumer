import { NextResponse } from "next/server";
import { hederaTestnetChain } from "@sh/relayer";
import { consumerAccountAbi, consumerAccountFactoryAbi, testnetDeployment, tinybarsToWeibars } from "@sh/sdk";
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, getAddress, http, isAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSponsor } from "~~/services/consumer/sponsorServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Testnet demo faucet: sends a one-time amount of HBAR from the sponsor to a ConsumerAccount deployed by this app's
 * factory, so visitors can try payments, savings, launches and agents without bringing HBAR. Bounded per account
 * (once), per day (FAUCET_DAILY_HBAR) and by a reserve the sponsor always keeps for fees (FAUCET_SPONSOR_RESERVE_HBAR).
 */
const TINYBARS = 100_000_000n;
const amountTinybars = () => BigInt(process.env.FAUCET_HBAR ?? "25") * TINYBARS;
const dailyTinybars = () => BigInt(process.env.FAUCET_DAILY_HBAR ?? "300") * TINYBARS;
const reserveTinybars = () => BigInt(process.env.FAUCET_SPONSOR_RESERVE_HBAR ?? "40") * TINYBARS;

type State = { day: number; spentTinybars: string; funded: Record<string, string> };

function stateFile(dir: string) {
  return path.join(dir, "faucet.json");
}
function load(dir: string): State {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), "utf8")) as State;
  } catch {
    return { day: 0, spentTinybars: "0", funded: {} };
  }
}
function save(dir: string, s: State) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), JSON.stringify(s, null, 2));
}
const today = () => Math.floor(Date.now() / 86_400_000);

let busy = false;

export async function GET(req: Request) {
  const s = getSponsor();
  if (!s.ok) return NextResponse.json({ enabled: false });
  const account = new URL(req.url).searchParams.get("account") ?? "";
  const dir = process.env.VERCEL ? "/tmp/relayer" : s.sponsor.cfg.RELAYER_DATA_DIR;
  const st = load(dir);
  return NextResponse.json({
    enabled: true,
    amountHbar: Number(amountTinybars() / TINYBARS),
    alreadyFunded: isAddress(account) ? Boolean(st.funded[getAddress(account)]) : false,
  });
}

export async function POST(req: Request) {
  const s = getSponsor();
  if (!s.ok) return NextResponse.json({ error: "FAUCET_NOT_CONFIGURED" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { account?: string } | null;
  if (!body?.account || !isAddress(body.account))
    return NextResponse.json({ error: "expected { account }" }, { status: 400 });
  const account = getAddress(body.account);
  const factory = testnetDeployment.factory;
  if (!factory) return NextResponse.json({ error: "NO_FACTORY" }, { status: 503 });
  const pc = s.sponsor.publicClient;

  // Only ConsumerAccounts deployed by this app's factory (salt 0).
  let owner: string;
  try {
    owner = await pc.readContract({ address: account, abi: consumerAccountAbi, functionName: "owner" });
  } catch {
    return NextResponse.json({ error: "NOT_A_CONSUMER_ACCOUNT" }, { status: 400 });
  }
  const expected = await pc.readContract({
    address: factory,
    abi: consumerAccountFactoryAbi,
    functionName: "getAddress",
    args: [owner, zeroHash],
  });
  if (getAddress(expected) !== account) return NextResponse.json({ error: "NOT_FROM_THIS_FACTORY" }, { status: 400 });

  if (busy) return NextResponse.json({ error: "FAUCET_BUSY: try again in a few seconds" }, { status: 429 });
  busy = true;
  try {
    const dir = process.env.VERCEL ? "/tmp/relayer" : s.sponsor.cfg.RELAYER_DATA_DIR;
    const st = load(dir);
    if (st.day !== today()) Object.assign(st, { day: today(), spentTinybars: "0" });
    if (st.funded[account])
      return NextResponse.json({ error: "ALREADY_FUNDED: this account already received demo HBAR" }, { status: 409 });
    const amount = amountTinybars();
    if (BigInt(st.spentTinybars) + amount > dailyTinybars()) {
      return NextResponse.json(
        { error: "FAUCET_DAILY_LIMIT: try again tomorrow or use portal.hedera.com/faucet" },
        { status: 429 },
      );
    }
    const key = s.sponsor.cfg.SPONSOR_PRIVATE_KEY;
    const signer = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
    const sponsorTinybars = (await pc.getBalance({ address: signer.address })) / 10_000_000_000n;
    if (sponsorTinybars < amount + reserveTinybars()) {
      return NextResponse.json(
        { error: "FAUCET_EMPTY: the sponsor keeps its HBAR for fees; use portal.hedera.com/faucet" },
        { status: 503 },
      );
    }
    const wallet = createWalletClient({
      chain: hederaTestnetChain(s.sponsor.cfg.HEDERA_RPC_URL),
      transport: http(s.sponsor.cfg.HEDERA_RPC_URL),
      account: signer,
    });
    const hash = await wallet.sendTransaction({ to: account, value: tinybarsToWeibars(amount) });
    const rcpt = await pc.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return NextResponse.json({ error: "FAUCET_TRANSFER_FAILED", hash }, { status: 502 });
    st.funded[account] = new Date().toISOString();
    st.spentTinybars = (BigInt(st.spentTinybars) + amount).toString();
    save(dir, st);
    return NextResponse.json({ ok: true, amountHbar: Number(amount / TINYBARS), hash });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 502 });
  } finally {
    busy = false;
  }
}
