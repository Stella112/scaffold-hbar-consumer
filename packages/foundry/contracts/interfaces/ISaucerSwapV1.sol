// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SaucerSwap V1 (Uniswap V2 style) router subset. Testnet RouterV3 0.0.19264, factory 0.0.9959
///         (docs.saucerswap.finance contract deployments, read live 2026-10-04).
/// @dev `addLiquidityETHNewPool` creates the HBAR/token pair, paying the factory's pool-creation fee
///      (`pairCreateFee()`, tinycents) out of msg.value, then adds liquidity and refunds unused HBAR to msg.sender.
interface ISaucerSwapV1Router {
    function factory() external view returns (address);
    function whbar() external view returns (address);

    function addLiquidityETHNewPool(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface ISaucerSwapV1Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function pairCreateFee() external view returns (uint256 tinycents);
}

/// @notice Hedera exchange-rate system contract (HIP-475) at 0x168.
interface IExchangeRate {
    function tinycentsToTinybars(uint256 tinycents) external returns (uint256);
}
