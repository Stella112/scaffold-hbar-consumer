"use client";

import { useCallback, useEffect, useState } from "react";
import type { Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Development/testnet signer adapter. The controller key lives in this browser's localStorage so the template
 * runs without a paid auth provider. It is NOT production custody: anyone with access to this browser profile
 * can read it. Swap this adapter for an embedded wallet or hardware-backed signer in production.
 */
const STORAGE_KEY = "scaffold-hbar-consumer.controller-key.testnet";

const read = (): Hex | null => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
};

export function useController() {
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const k = read();
    setAccount(k ? privateKeyToAccount(k) : null);
    setReady(true);
  }, []);

  const create = useCallback(() => {
    const k = generatePrivateKey();
    try {
      localStorage.setItem(STORAGE_KEY, k);
    } catch {
      // Storage blocked: key lives only for this page session.
    }
    setAccount(privateKeyToAccount(k));
  }, []);

  const forget = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setAccount(null);
  }, []);

  return { controller: account, ready, create, forget };
}
