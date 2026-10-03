export function formatUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (frac) frac = `.${frac}`;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac}`;
}

export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter a number like 1.5");
  const [w = "0", f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
