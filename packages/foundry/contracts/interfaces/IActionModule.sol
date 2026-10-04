// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A typed-action module: a read-only planner the account owner installs for one action ID.
/// @dev The module never holds authority. ConsumerAccount calls `plan` (view), charges the declared worst-case spend
///      against the session's USD caps and recipient allowlist, executes the returned calls itself, then verifies
///      the declared asset decreased by at most `spendAmount` and charges any extra HBAR outflow. Calls to the account
///      itself or to the HTS system contract are always rejected. Modules are trusted like owner-installed code:
///      install only modules you have reviewed. Scaffold one with `yarn new:action <name>`.
interface IActionModule {
    struct PlannedCall {
        address target;
        uint256 value; // tinybars inside the Hedera EVM
        bytes data;
    }

    /// @param account the ConsumerAccount executing the action
    /// @param actionData the session-signed action payload
    /// @return spendAsset address(0) for HBAR, else the token the action spends
    /// @return recipient who the spend goes to (checked against the session's recipient allowlist)
    /// @return spendAmount worst-case amount of spendAsset that may leave the account
    /// @return calls what the account should execute, in order
    function plan(address account, bytes calldata actionData)
        external
        view
        returns (address spendAsset, address recipient, uint256 spendAmount, PlannedCall[] memory calls);
}
