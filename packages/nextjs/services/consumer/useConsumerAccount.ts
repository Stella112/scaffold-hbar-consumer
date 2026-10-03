"use client";

import { publicClient } from "./client";
import { consumerAccountFactoryAbi, testnetDeployment, weibarsToTinybars } from "@sh/sdk";
import { useQuery } from "@tanstack/react-query";
import { type Address, erc20Abi, zeroHash } from "viem";

export type TokenBalance = { symbol: string; tokenId: string; decimals: number; address: Address; balance: bigint };

/** The controller's ConsumerAccount address (CREATE2, salt 0), deployment state and balances (read from RPC). */
export function useConsumerAccount(controller: Address | undefined) {
  const factory = testnetDeployment.factory;
  return useQuery({
    queryKey: ["consumer-account", controller, factory],
    enabled: Boolean(controller && factory),
    refetchInterval: 15_000,
    queryFn: async () => {
      const address = await publicClient.readContract({
        address: factory!,
        abi: consumerAccountFactoryAbi,
        functionName: "getAddress",
        args: [controller!, zeroHash],
      });
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
        deployed,
        hbarTinybars: weibarsToTinybars(accountWei),
        controllerTinybars: weibarsToTinybars(controllerWei),
        tokens,
      };
    },
  });
}
