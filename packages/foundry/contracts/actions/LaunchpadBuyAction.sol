// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IActionModule } from "../interfaces/IActionModule.sol";
import { TokenLaunchpad } from "../TokenLaunchpad.sol";

/// @title LaunchpadBuyAction
/// @notice Typed action `consumer.action.launchpad-buy.v1`: buy from one TokenLaunchpad at its quoted price.
/// @dev actionData = abi.encode(uint256 launchId, uint64 amount, uint256 maxCostTinybars). The account prices the
///      quoted HBAR cost against the session's USD caps; the launchpad is the only recipient.
contract LaunchpadBuyAction is IActionModule {
    bytes32 public constant ID = keccak256("consumer.action.launchpad-buy.v1");
    TokenLaunchpad public immutable launchpad;

    error CostAboveMaximum(uint256 cost, uint256 maxCost);

    constructor(TokenLaunchpad launchpad_) {
        launchpad = launchpad_;
    }

    function plan(address, bytes calldata actionData)
        external
        view
        returns (address spendAsset, address recipient, uint256 spendAmount, PlannedCall[] memory calls)
    {
        (uint256 id, uint64 amount, uint256 maxCost) = abi.decode(actionData, (uint256, uint64, uint256));
        uint256 cost = launchpad.quote(id, amount);
        if (cost > maxCost) revert CostAboveMaximum(cost, maxCost);
        calls = new PlannedCall[](1);
        calls[0] = PlannedCall({
            target: address(launchpad), value: cost, data: abi.encodeCall(TokenLaunchpad.buy, (id, amount))
        });
        return (address(0), address(launchpad), cost, calls);
    }
}
