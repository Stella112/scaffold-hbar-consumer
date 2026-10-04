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

/**
 * After guardian recovery, the new key controls an account at a different address than the one it would create
 * itself. Linking stores that address so the app uses it (only honoured while this key is the account's owner).
 */
const LINK_KEY = "scaffold-hbar-consumer.linked-account.testnet";

export function readLinkedAccount(): `0x${string}` | null {
  try {
    const v = localStorage.getItem(LINK_KEY);
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export function writeLinkedAccount(address: string | null) {
  try {
    if (address) localStorage.setItem(LINK_KEY, address);
    else localStorage.removeItem(LINK_KEY);
  } catch {
    // ignore
  }
}
