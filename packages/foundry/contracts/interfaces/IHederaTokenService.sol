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

    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    /// keyType bit flags: 0 admin, 1 kyc, 2 freeze, 3 wipe, 4 supply, 5 feeSchedule, 6 pause.
    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType; // true = FINITE
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    function associateToken(address account, address token) external returns (int64 responseCode);

    /// msg.value pays the token-creation fee (in tinybars inside the EVM).
    function createFungibleToken(HederaToken memory token, int64 initialTotalSupply, int32 decimals)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    /// HIP-904: delivers immediately when the receiver is associated or has a free auto-association slot,
    /// otherwise records a pending airdrop the receiver can claim.
    function airdropTokens(TokenTransferList[] memory tokenTransfers) external returns (int64 responseCode);

    function cancelAirdrops(PendingAirdrop[] memory pendingAirdrops) external returns (int64 responseCode);
}
