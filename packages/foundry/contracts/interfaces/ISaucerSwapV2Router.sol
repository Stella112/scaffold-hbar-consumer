// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SaucerSwap V2 SwapRouter exact-output entrypoint.
/// @dev Struct and signature from docs.saucerswap.finance/developers/v2/swap/swap-tokens-for-tokens and verified
///      against deployed testnet bytecode (0.0.1414040 contains selector 0xf28c0498). See docs/SOURCES.md.
interface ISaucerSwapV2Router {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}
