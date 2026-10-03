// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stable typed-action identifiers. Session keys can only execute actions from this registry;
///         they never receive raw (target, value, calldata) authority.
/// @dev Mirrored in packages/sdk/src/actions.ts. Changing an ID is a breaking change.
library Actions {
    /// actionData = abi.encode(address asset, address to, uint256 amount); asset 0 = HBAR (tinybars)
    bytes32 internal constant PAYMENT = keccak256("consumer.action.payment.v1");
    /// actionData = abi.encode(address token, address to, uint256 amount); HIP-904 airdrop
    bytes32 internal constant AIRDROP = keccak256("consumer.action.airdrop.v1");
    /// Used for session-signed x402 transferExecutor authorizations (not dispatched through executeSessionAction).
    bytes32 internal constant X402_PAYMENT = keccak256("consumer.action.x402-payment.v1");
    /// actionData = abi.encode(ConsumerAccount.SwapToPay); SaucerSwap V2 exact-output swap paid to a recipient
    bytes32 internal constant SWAP_TO_PAY = keccak256("consumer.action.swap-to-pay.v1");
    /// actionData = abi.encode(address vault, uint256 assets); ERC-4626 deposit into an owner-allowlisted vault,
    /// shares always minted to the account itself
    bytes32 internal constant VAULT_DEPOSIT = keccak256("consumer.action.vault-deposit.v1");

    // Reserved privileged identifiers. A session presenting one of these is attempting escalation.
    bytes32 internal constant ADMIN_SET_OWNER = keccak256("consumer.admin.set-owner.v1");
    bytes32 internal constant ADMIN_GRANT_SESSION = keccak256("consumer.admin.grant-session.v1");
    bytes32 internal constant ADMIN_REVOKE_SESSION = keccak256("consumer.admin.revoke-session.v1");
    bytes32 internal constant ADMIN_SET_GUARDIANS = keccak256("consumer.admin.set-guardians.v1");
    bytes32 internal constant ADMIN_RECOVERY = keccak256("consumer.admin.recovery.v1");
    bytes32 internal constant ADMIN_SET_ORACLE = keccak256("consumer.admin.set-oracle.v1");

    // Reserved withdrawal identifiers. Sessions may never withdraw user-controlled vault assets.
    bytes32 internal constant VAULT_WITHDRAW = keccak256("consumer.action.vault-withdraw.v1");
    bytes32 internal constant VAULT_REDEEM = keccak256("consumer.action.vault-redeem.v1");

    function isPrivileged(bytes32 id) internal pure returns (bool) {
        return id == ADMIN_SET_OWNER || id == ADMIN_GRANT_SESSION || id == ADMIN_REVOKE_SESSION
            || id == ADMIN_SET_GUARDIANS || id == ADMIN_RECOVERY || id == ADMIN_SET_ORACLE;
    }

    function isWithdrawal(bytes32 id) internal pure returns (bool) {
        return id == VAULT_WITHDRAW || id == VAULT_REDEEM;
    }
}
