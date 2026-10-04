// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ConsumerAccount } from "./ConsumerAccount.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @title ConsumerAccountFactory
/// @notice Deterministically deploys ConsumerAccounts as EIP-1167 clones of one implementation. Anyone (e.g. a
///         sponsor) may deploy an account for an owner; the clone is created and initialized in the same call, so
///         there is no initialization step to front-run, and the factory keeps no authority over deployed accounts.
/// @dev Clones keep the factory tiny: the account's code no longer counts against the factory's 24 KB limit.
contract ConsumerAccountFactory {
    /// The ConsumerAccount implementation every clone delegates to (initializers disabled on it).
    address public immutable accountImplementation;
    /// Oracle given to new accounts. Owners can change it later through a signed self-call.
    IPriceOracle public immutable defaultOracle;

    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    error InvalidImplementation();

    constructor(address accountImplementation_, IPriceOracle defaultOracle_) {
        if (accountImplementation_.code.length == 0) revert InvalidImplementation();
        accountImplementation = accountImplementation_;
        defaultOracle = defaultOracle_;
    }

    /// @notice Returns the account for (owner, salt), deploying it if needed. Idempotent.
    function createAccount(address owner, bytes32 salt) external returns (ConsumerAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length != 0) return ConsumerAccount(payable(predicted));
        account = ConsumerAccount(payable(Clones.cloneDeterministic(accountImplementation, _salt(owner, salt))));
        account.initialize(owner, defaultOracle);
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, _salt(owner, salt), address(this));
    }

    /// @dev The owner is part of the CREATE2 salt, so nobody can claim another owner's address.
    function _salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
