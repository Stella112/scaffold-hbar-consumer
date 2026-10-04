// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { ConsumerAccount } from "./ConsumerAccount.sol";
import { CodeChunkStore } from "./CodeChunkStore.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @title ConsumerAccountFactory
/// @notice Deterministically deploys full ConsumerAccount contracts. Anyone (e.g. a sponsor) may deploy an account for
///         an owner; the owner is fixed in the constructor, so there is no initialization step to front-run, and
///         the factory keeps no authority over deployed accounts.
/// @dev The account's creation code lives in small data contracts (CodeChunkStore) rather than inside the factory,
///      so the factory stays far below the 24 KB contract-size limit while accounts remain real contracts (not
///      delegatecall proxies, whose keys Hedera does not activate for scheduled or signed system-contract calls).
contract ConsumerAccountFactory {
    /// Data contracts holding ConsumerAccount's creation code, in order.
    address[] public codeChunks;
    /// keccak256 of the concatenated creation code, checked at construction.
    bytes32 public immutable accountCodeHash;
    /// Every account this factory deployed. Stays true after guardian recovery changes the owner (the CREATE2 address
    /// is derived from the original owner, so it cannot identify recovered accounts).
    mapping(address => bool) public isAccount;
    /// Oracle given to new accounts. Owners can change it later through a signed self-call.
    IPriceOracle public immutable defaultOracle;

    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    error InvalidCode();
    error DeployFailed();

    constructor(address[] memory chunks, bytes32 expectedCodeHash, IPriceOracle defaultOracle_) {
        if (chunks.length == 0) revert InvalidCode();
        for (uint256 i; i < chunks.length; ++i) {
            if (CodeChunkStore.size(chunks[i]) == 0) revert InvalidCode();
            codeChunks.push(chunks[i]);
        }
        if (keccak256(_accountCode()) != expectedCodeHash) revert InvalidCode();
        accountCodeHash = expectedCodeHash;
        defaultOracle = defaultOracle_;
    }

    /// @notice Returns the account for (owner, salt), deploying it if needed. Idempotent.
    function createAccount(address owner, bytes32 salt) external returns (ConsumerAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length != 0) return ConsumerAccount(payable(predicted));
        bytes memory initCode = _initCode(owner);
        bytes32 s = _salt(owner, salt);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 32), mload(initCode), s)
        }
        if (deployed == address(0)) revert DeployFailed();
        account = ConsumerAccount(payable(deployed));
        isAccount[deployed] = true;
        emit AccountCreated(deployed, owner, salt);
    }

    function getAddress(address owner, bytes32 salt) public view returns (address) {
        return Create2.computeAddress(_salt(owner, salt), keccak256(_initCode(owner)));
    }

    function _initCode(address owner) internal view returns (bytes memory) {
        return abi.encodePacked(_accountCode(), abi.encode(owner, address(defaultOracle)));
    }

    function _accountCode() internal view returns (bytes memory code) {
        uint256 total;
        uint256 n = codeChunks.length;
        for (uint256 i; i < n; ++i) {
            total += CodeChunkStore.size(codeChunks[i]);
        }
        code = new bytes(total);
        uint256 dest;
        assembly ("memory-safe") {
            dest := add(code, 32)
        }
        for (uint256 i; i < n; ++i) {
            address c = codeChunks[i];
            uint256 len = CodeChunkStore.size(c);
            CodeChunkStore.copyTo(c, dest, len);
            dest += len;
        }
    }

    /// @dev The owner is part of the CREATE2 salt, so nobody can claim another owner's address.
    function _salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
