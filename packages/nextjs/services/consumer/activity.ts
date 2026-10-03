import type { ReceiptJson } from "./client";

/** Per-browser activity log (convenience only; the source of truth is the network / Mirror Node). */
const KEY = "scaffold-hbar-consumer.activity.v1";

export function saveReceipt(r: ReceiptJson): void {
  try {
    const list = loadReceipts();
    list.unshift({ ...r, savedAt: new Date().toISOString() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100)));
  } catch {
    // storage unavailable
  }
}

export function loadReceipts(): (ReceiptJson & { savedAt?: string })[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
