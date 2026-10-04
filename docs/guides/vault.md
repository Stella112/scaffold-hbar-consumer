# Savings vault (recipe)

`SavingsVault` is an OpenZeppelin ERC-4626 vault over one HTS token (WHBAR in the reference deployment). Its
constructor associates the vault with the token; a decimals offset of 9 defeats first-depositor inflation.

- Owners deposit and redeem on the **Save** page.
- Agents can be granted `vault-deposit`: only owner-allowlisted vaults (`setVault`), counted against USD caps,
  exact approval reset afterwards, shares always minted to the account.
- Agents can never withdraw: `vault-withdraw` / `vault-redeem` are reserved, and the shares of any vault ever
  allowed are untransferable for sessions through every action (payment, airdrop, x402, modules' declared asset).

Testnet flow 11.
