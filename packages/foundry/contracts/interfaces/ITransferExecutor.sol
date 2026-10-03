// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice x402 `exact` scheme on Hedera, asset transfer method `transferExecutor`.
/// @dev Signature copied from x402-foundation/x402 `specs/schemes/exact/scheme_exact_hedera.md`
///      (selector 0xea8f19fd). MUST revert unless `authorization` permits exactly this transfer, and a
///      successful call MUST consume the authorization.
interface ITransferExecutor {
    function executeTransfer(address from, address asset, address to, uint256 amount, bytes calldata authorization)
        external;
}
