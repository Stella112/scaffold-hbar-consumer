// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CodeChunkStore
/// @notice Stores bytes as the runtime code of a data contract (SSTORE2 pattern) and reads them back. Each data
///         contract's code is 0x00 (STOP, so calling it does nothing) followed by the stored bytes.
library CodeChunkStore {
    error WriteFailed();

    /// @dev Creation code = 12-byte loader + 0x00 + data. The loader copies everything after itself and returns it.
    function creationCode(bytes memory data) internal pure returns (bytes memory) {
        uint256 len = data.length + 1;
        return abi.encodePacked(hex"61", uint16(len), hex"80600c6000396000f3", hex"00", data);
    }

    function write(bytes memory data) internal returns (address pointer) {
        bytes memory code = creationCode(data);
        assembly ("memory-safe") {
            pointer := create(0, add(code, 32), mload(code))
        }
        if (pointer == address(0)) revert WriteFailed();
    }

    /// @notice Length of the stored bytes (code size minus the STOP prefix).
    function size(address pointer) internal view returns (uint256) {
        uint256 s = pointer.code.length;
        return s == 0 ? 0 : s - 1;
    }

    /// @notice Copies the stored bytes of `pointer` into memory at `dest`.
    function copyTo(address pointer, uint256 dest, uint256 len) internal view {
        assembly ("memory-safe") {
            extcodecopy(pointer, dest, 1, len)
        }
    }
}
