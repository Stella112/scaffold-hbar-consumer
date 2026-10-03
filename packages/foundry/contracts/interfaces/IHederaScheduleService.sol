// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Subset of the Hedera Schedule Service system contract (0x16b) used for recurring payments.
/// @dev HIP-1215 (hiero-ledger/hiero-contracts contracts/schedule-service/IHRC1215.sol). Calls return a Hedera
///      response code (22 = SUCCESS) rather than reverting. `scheduleCall` makes the calling contract the payer of
///      the scheduled transaction.
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);
}
