// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ConsumerAccount } from "./ConsumerAccount.sol";
import { ConsumerAccountFactory } from "./ConsumerAccountFactory.sol";
import { CodeChunkStore } from "./CodeChunkStore.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @notice Deploys ConsumerAccount's creation code as data chunks and a factory over them (Foundry scripts and tests).
///         `yarn bootstrap` does the same from TypeScript.
library AccountFactoryDeployer {
    /// @dev Each chunk stays well below the 24 KB code-size limit.
    uint256 internal constant CHUNK = 12_000;

    function deploy(IPriceOracle oracle) internal returns (ConsumerAccountFactory) {
        bytes memory code = type(ConsumerAccount).creationCode;
        uint256 n = (code.length + CHUNK - 1) / CHUNK;
        address[] memory chunks = new address[](n);
        for (uint256 i; i < n; ++i) {
            uint256 start = i * CHUNK;
            uint256 len = code.length - start < CHUNK ? code.length - start : CHUNK;
            bytes memory part = new bytes(len);
            for (uint256 j; j < len; ++j) {
                part[j] = code[start + j];
            }
            chunks[i] = CodeChunkStore.write(part);
        }
        return new ConsumerAccountFactory(chunks, keccak256(code), oracle);
    }
}
