"use client";

import { publicClient } from "./client";
import { readLinkedAccount } from "./controller";
import { consumerAccountAbi, consumerAccountFactoryAbi, testnetDeployment, weibarsToTinybars } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import { type Address, erc20Abi, zeroHash } from "viem";

export type TokenBalance = { symbol: string; tokenId: string; decimals: number; address: Address; balance: bigint };

/** The controller's ConsumerAccount address (CREATE2, salt 0), deployment state and balances (read from RPC). */
export function useConsumerAccount(controller: Address | undefined) {
  const factory = testnetDeployment.factory;
  return useQuery({
    queryKey: ["consumer-account", controller, factory, typeof window === "undefined" ? null : readLinkedAccount()],
    enabled: Boolean(controller && factory),
    refetchInterval: 15_000,
    queryFn: async () => {
      const predicted = await publicClient.readContract({
        address: factory!,
        abi: consumerAccountFactoryAbi,
        functionName: "getAddress",
        args: [controller!, zeroHash],
      });
      // A recovered account (see Recovery) is used only while this controller is its owner.
      const linked = readLinkedAccount();
      const linkedOwner = linked
        ? await publicClient
            .readContract({ address: linked, abi: consumerAccountAbi, functionName: "owner" })
            .catch(() => null)
        : null;
      const address =
        linked && linkedOwner && linkedOwner.toLowerCase() === controller!.toLowerCase() ? linked : predicted;
      const code = await publicClient.getCode({ address });
      const deployed = Boolean(code && code !== "0x");
      const [accountWei, controllerWei] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.getBalance({ address: controller! }),
      ]);
      const tokens: TokenBalance[] = await Promise.all(
        Object.values(testnetDeployment.tokens ?? {}).map(async t => ({
          symbol: t.symbol,
          tokenId: t.tokenId,
          decimals: t.decimals,
          address: t.address,
          balance: deployed
            ? await publicClient
                .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
                .catch(() => 0n)
            : 0n,
        })),
      );
      return {
        address,
        recovered: address !== predicted,
        deployed,
        hbarTinybars: weibarsToTinybars(accountWei),
        controllerTinybars: weibarsToTinybars(controllerWei),
        tokens,
      };
    },
  });
}
