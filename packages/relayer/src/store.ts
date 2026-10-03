import fs from "node:fs";
import path from "node:path";
import { type Receipt, receiptToJson } from "@sh/sdk";
import { type SpendState, emptySpendState, rollDay } from "./policy";

/**
 * Local operational state (spend counters, dedupe keys, recent receipts). This is NOT on-chain data; the
 * dashboard labels it "local operational metrics". Network-derived data is always re-read from Mirror Node.
 */
type Persisted = {
  day: string;
  totalTinybars: string;
  perUserTinybars: Record<string, string>;
  seen: string[];
  receipts: string[];
};

const MAX_RECEIPTS = 200;
const MAX_SEEN = 5_000;

export class RelayerStore {
  spend: SpendState;
  private seen: Set<string>;
  private receipts: string[];
  private readonly file: string | null;

  constructor(dataDir: string | null, now = Date.now()) {
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    this.spend = emptySpendState(now);
    this.seen = new Set();
    this.receipts = [];
    if (this.file && fs.existsSync(this.file)) {
      const p = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
      this.spend = rollDay(
        {
          day: p.day,
          totalTinybars: BigInt(p.totalTinybars),
          perUserTinybars: new Map(Object.entries(p.perUserTinybars).map(([k, v]) => [k, BigInt(v)])),
          recentRequests: new Map(),
        },
        now,
      );
      this.seen = new Set(p.seen);
      this.receipts = p.receipts;
    }
  }

  /** Returns false if the key was already used (duplicate request). */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  release(key: string): void {
    this.seen.delete(key);
  }

  addReceipt(r: Receipt): void {
    this.receipts.unshift(receiptToJson(r));
    this.receipts.length = Math.min(this.receipts.length, MAX_RECEIPTS);
  }

  recentReceipts(): unknown[] {
    return this.receipts.map(r => JSON.parse(r));
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const p: Persisted = {
      day: this.spend.day,
      totalTinybars: this.spend.totalTinybars.toString(),
      perUserTinybars: Object.fromEntries([...this.spend.perUserTinybars].map(([k, v]) => [k, v.toString()])),
      seen: [...this.seen].slice(-MAX_SEEN),
      receipts: this.receipts,
    };
    fs.writeFileSync(this.file, JSON.stringify(p, null, 2));
  }
}
