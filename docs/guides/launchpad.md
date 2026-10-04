# Token launchpad (recipe)

`TokenLaunchpad.launch` creates an HTS token through the Token Service with no admin, supply, freeze, wipe or
pause keys and a finite supply, held by the launchpad. Buyers pay HBAR at a fixed price.

- Reaching the target lets anyone `graduate` once: the creator receives the HBAR; a second call reverts
  `AlreadyGraduated` (effects before interactions, `nonReentrant`).
- Buyers and the creator `claim` by HIP-904 airdrop; the claim funds its own airdrop fee and refunds the rest.
- Missing the deadline opens one-time refunds instead.
- Agents can buy through the `launchpad-buy` action module (`contracts/actions/LaunchpadBuyAction.sol`), priced
  against their USD caps with a `maxCost` bound.

Testnet flow 12; app page **Launch**.
