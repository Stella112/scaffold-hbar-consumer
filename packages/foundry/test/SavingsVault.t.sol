// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { SavingsVault } from "../contracts/SavingsVault.sol";
import { Actions } from "../contracts/Actions.sol";
import { AccountFixture } from "./ConsumerAccount.t.sol";

/// Savings vault recipe: sessions deposit within caps, never withdraw or move shares; the owner redeems.
contract SavingsVaultTest is AccountFixture {
    SavingsVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = new SavingsVault(IERC20(address(usdc)), "Savings TUSD", "svTUSD");
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setVault, (address(vault), true)));
        bytes32[] memory actions = new bytes32[](3);
        actions[0] = Actions.VAULT_DEPOSIT;
        actions[1] = Actions.PAYMENT;
        actions[2] = Actions.X402_PAYMENT;
        _grant(sessionKey, actions, new address[](0), 10e6, 25e6, uint64(block.timestamp + 1 days));
    }

    function _deposit(address v, uint256 assets) internal {
        ConsumerAccount.SessionAction memory a = _action(Actions.VAULT_DEPOSIT, abi.encode(v, assets));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
    }

    function test_sessionDepositsWithinCapsAndSharesGoToAccount() public {
        _deposit(address(vault), 5e6);
        assertEq(usdc.balanceOf(address(vault)), 5e6);
        assertEq(vault.balanceOf(address(account)), 5e6 * 1e9); // decimals offset 9
        assertEq(vault.maxWithdraw(address(account)), 5e6);
        assertEq(usdc.allowance(address(account), address(vault)), 0); // approval reset
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 5e6);
    }

    function test_depositOverCapDenied() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.VAULT_DEPOSIT, abi.encode(address(vault), 11e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_depositIntoUnlistedVaultDenied() public {
        SavingsVault other = new SavingsVault(IERC20(address(usdc)), "Other", "oTUSD");
        ConsumerAccount.SessionAction memory a = _action(Actions.VAULT_DEPOSIT, abi.encode(address(other), 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.TargetNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_sessionWithoutDepositActionDenied() public {
        _grantDefaultSession(); // payment + x402 only
        ConsumerAccount.SessionAction memory a = _action(Actions.VAULT_DEPOSIT, abi.encode(address(vault), 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_sessionCannotWithdrawOrRedeem() public {
        _deposit(address(vault), 5e6);
        bytes32[2] memory ids = [Actions.VAULT_WITHDRAW, Actions.VAULT_REDEEM];
        for (uint256 i; i < ids.length; ++i) {
            ConsumerAccount.SessionAction memory a = _action(ids[i], abi.encode(address(vault), 1e6));
            bytes memory sig = _signAction(a, sessionPk);
            vm.expectRevert(ConsumerAccount.WithdrawForbidden.selector);
            account.executeSessionAction(a, sig);
        }
    }

    function test_sessionCannotPayOutVaultShares() public {
        _deposit(address(vault), 5e6);
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(vault), stranger, 1e15));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.WithdrawForbidden.selector);
        account.executeSessionAction(a, sig);
        assertEq(vault.balanceOf(stranger), 0);
    }

    function test_sessionCannotMoveVaultSharesThroughX402() public {
        _deposit(address(vault), 5e6);
        uint64 validUntil = uint64(block.timestamp + 180);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "TransferAuthorization(address from,address asset,address to,uint256 amount,uint256 nonce,uint64 validUntil)"
                ),
                address(account),
                address(vault),
                stranger,
                uint256(1e12),
                uint256(777),
                validUntil
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionPk, keccak256(abi.encodePacked("\x19\x01", account.domainSeparator(), structHash)));
        vm.expectRevert(ConsumerAccount.WithdrawForbidden.selector);
        account.executeTransfer(
            address(account),
            address(vault),
            stranger,
            1e12,
            abi.encode(uint256(777), validUntil, abi.encodePacked(r, s, v))
        );
    }

    function test_sharesStayLockedForSessionsAfterVaultIsDelisted() public {
        _deposit(address(vault), 5e6);
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setVault, (address(vault), false)));
        assertTrue(account.isVaultShare(address(vault)));
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(vault), stranger, 1e15));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.WithdrawForbidden.selector);
        account.executeSessionAction(a, sig);
    }

    function test_ownerRedeems() public {
        _deposit(address(vault), 5e6);
        uint256 shares = vault.balanceOf(address(account));
        uint256 before = usdc.balanceOf(address(account));
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(
            _call(address(vault), 0, abi.encodeCall(vault.redeem, (shares, address(account), address(account))))
        );
        bytes memory sig = _signOwner(account, intent, ownerPk);
        account.executeOwnerIntent(intent, sig);
        assertEq(usdc.balanceOf(address(account)) - before, 5e6);
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function test_firstDepositorInflationIsBlunted() public {
        // Attacker deposits 1 unit then donates a large amount to skew the price.
        address attacker = makeAddr("attacker");
        usdc.mint(attacker, 1_000_001e6);
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1, attacker);
        usdc.transfer(address(vault), 1_000_000e6);
        vm.stopPrank();
        _deposit(address(vault), 5e6);
        // The victim keeps at least 99.9% and the attacker ends up with less than it put in.
        assertGe(vault.maxWithdraw(address(account)), 5e6 - 5e3);
        assertLt(vault.maxWithdraw(attacker), 1_000_000e6 + 1);
    }

    function test_constructorChecksHtsAssociation() public {
        vm.store(address(0x167), bytes32(0), bytes32(uint256(7)));
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.HtsCallFailed.selector, int64(7)));
        new SavingsVault(IERC20(address(usdc)), "X", "X");
    }

    function test_onlyOwnerSetsVaults() public {
        vm.prank(sessionKey);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setVault(address(vault), true);
    }
}
