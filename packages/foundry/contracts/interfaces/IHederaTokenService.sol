// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Minimal subset of the Hedera Token Service system contract (0x167) used by this template.
/// @dev Struct layouts and signatures copied from hiero-ledger/hiero-contracts
///      `contracts/token-service/IHederaTokenService.sol` (checked 2026-10-03, see docs/SOURCES.md).
///      Every function returns a Hedera response code; callers MUST check it (SUCCESS == 22).
interface IHederaTokenService {
    struct AccountAmount {
        address accountID;
        int64 amount;
        bool isApproval;
    }

    struct NftTransfer {
        address senderAccountID;
        address receiverAccountID;
        int64 serialNumber;
        bool isApproval;
    }

    struct TokenTransferList {
        address token;
        AccountAmount[] transfers;
        NftTransfer[] nftTransfers;
    }

    struct PendingAirdrop {
        address sender;
        address receiver;
        address token;
        int64 serial;
    }

    function associateToken(address account, address token) external returns (int64 responseCode);

    /// HIP-904: delivers immediately when the receiver is associated or has a free auto-association slot,
    /// otherwise records a pending airdrop the receiver can claim.
    function airdropTokens(TokenTransferList[] memory tokenTransfers) external returns (int64 responseCode);

    function cancelAirdrops(PendingAirdrop[] memory pendingAirdrops) external returns (int64 responseCode);
}
