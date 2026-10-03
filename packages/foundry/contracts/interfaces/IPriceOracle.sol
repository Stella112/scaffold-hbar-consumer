// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Values an asset amount in USD with 6 decimals (USD6). Used by session spending caps.
/// @dev Implementations MUST return ok == false (never a guessed value) for unsupported assets, stale or
///      invalid prices. ConsumerAccount treats ok == false as PriceUnavailable and denies session spend.
interface IPriceOracle {
    /// @param asset address(0) for HBAR (amount in tinybars), otherwise the HTS token EVM address
    /// @param amount amount in the asset's smallest unit
    function quoteUsd6(address asset, uint256 amount) external view returns (bool ok, uint256 usd6);
}
