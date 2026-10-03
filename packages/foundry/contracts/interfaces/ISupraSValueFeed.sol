// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Supra push-oracle storage contract (docs.supra.com/oracles/data-feeds/push-oracle).
///         Hedera testnet: 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917 · mainnet: 0xD02cc7a670047b6b012556A88e275c685d25e0c9.
/// @dev `time` is a Unix timestamp in milliseconds; `price` has `decimals` decimals.
interface ISupraSValueFeed {
    struct priceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    function getSvalue(uint256 _pairIndex) external view returns (priceFeed memory);
}
