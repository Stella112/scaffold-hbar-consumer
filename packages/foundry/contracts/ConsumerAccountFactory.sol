// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { ConsumerAccount } from "./ConsumerAccount.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @title ConsumerAccountFactory
/// @notice Deterministically deploys ConsumerAccounts. Anyone (e.g. a sponsor) may deploy an account for an owner;
///         the owner is fixed in the constructor, so there is no initialization step to front-run and the
///         factory keeps no authority over deployed accounts.
contract ConsumerAccountFactory {
    /// Oracle given to new accounts. Owners can change it later through a signed self-call.
    IPriceOracle public immutable defaultOracle;

    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    constructor(IPriceOracle defaultOracle_) {
        defaultOracle = defaultOracle_;
    }

    /// @notice Returns the account for (owner, salt), deploying it if needed. Idempotent.
    function createAccount(address owner, bytes32 salt) external returns (ConsumerAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length != 0) return ConsumerAccount(payable(predicted));
        account = new ConsumerAccount{ salt: _salt(owner, salt) }(owner, defaultOracle);
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, bytes32 salt) public view returns (address) {
        bytes memory initCode =
            abi.encodePacked(type(ConsumerAccount).creationCode, abi.encode(owner, address(defaultOracle)));
        return Create2.computeAddress(_salt(owner, salt), keccak256(initCode));
    }

    /// @dev The owner is part of the CREATE2 salt, so nobody can claim another owner's address.
    function _salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
