// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { ConsumerAccountFactory } from "../contracts/ConsumerAccountFactory.sol";
import { Actions } from "../contracts/Actions.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { AccountFixture } from "./ConsumerAccount.t.sol";

/// Network fees charged to the account during a session action count against the session's USD caps.
/// Fixture prices: 1 TUSD = $1.00, 1 HBAR = $0.05; the mock HTS charges 1 HBAR per airdrop like Hedera does.
contract AgentFeeCapsTest is AccountFixture {
    function setUp() public override {
        super.setUp();
        hts.setAirdropHbarFee(1e8); // 1 HBAR = $0.05
        bytes32[] memory actions = new bytes32[](2);
        actions[0] = Actions.AIRDROP;
        actions[1] = Actions.PAYMENT;
        _grant(sessionKey, actions, new address[](0), 1e6, 2e6, uint64(block.timestamp + 1 days)); // $1 / $2
    }

    function _airdrop(uint256 amount) internal {
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, amount));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
    }

    function test_airdropFeeIsChargedToTheSession() public {
        uint256 hbarBefore = address(account).balance;
        _airdrop(0.5e6); // $0.50 of tokens + $0.05 fee
        assertEq(hbarBefore - address(account).balance, 1e8);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 0.55e6);
    }

    function test_feePushingOverPerCallCapRevertsWholeAction() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 0.98e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector); // $0.98 + $0.05 > $1
        account.executeSessionAction(a, sig);
        // (A cheatcode balance change inside a reverted call is not rolled back in Foundry; on Hedera the whole
        // transaction, airdrop fee included, reverts.) The session records no spend.
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 0);
    }

    function test_feesCannotExceedDailyCapThroughRepetition() public {
        _airdrop(0.9e6); // 0.95
        _airdrop(0.9e6); // 1.90
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 0.06e6));
        bytes memory sig = _signAction(a, sessionPk);
        // Tokens alone fit (1.90 + 0.06 = 1.96); the fee pushes it over (2.01 > 2).
        vm.expectRevert(ConsumerAccount.DailyCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_intendedHbarPaymentIsNotChargedTwice() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(0), merchant, 10e8)); // $0.50
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 0.5e6);
    }

    function test_ownerAirdropIsNotCapped() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 50e6));
        bytes memory sig = _signAction(a, ownerPk);
        account.executeSessionAction(a, sig);
        assertEq(hts.lastAmount(), int64(50e6)); // $50 airdrop + fee, no session caps on the owner path
    }

    function test_unpriceableFeeFailsClosed() public {
        vm.prank(address(account));
        account.setOracle(IPriceOracle(address(0)));
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 0.1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PriceUnavailable.selector);
        account.executeSessionAction(a, sig);
    }
}

/// Factory: full accounts from creation code kept in data-contract chunks.
contract ChunkedFactoryTest is AccountFixture {
    function test_accountsAreFullContractsNotProxies() public view {
        assertGt(address(account).code.length, 10_000);
        assertEq(account.owner(), ownerAddr);
    }

    function test_predictionMatchesAndCreationIsIdempotent() public {
        address predicted = factory.getAddress(stranger, bytes32(uint256(7)));
        ConsumerAccount a = factory.createAccount(stranger, bytes32(uint256(7)));
        assertEq(address(a), predicted);
        assertEq(address(factory.createAccount(stranger, bytes32(uint256(7)))), predicted);
        assertEq(a.owner(), stranger);
    }

    function test_ownerIsBoundToTheAddress() public view {
        assertTrue(factory.getAddress(stranger, bytes32(0)) != factory.getAddress(ownerAddr, bytes32(0)));
    }

    function test_factoryIsSmall() public view {
        assertLt(address(factory).code.length, 4_000);
    }

    function test_factoryRejectsWrongCode() public {
        address[] memory chunks = new address[](1);
        chunks[0] = factory.codeChunks(0); // only part of the code
        bytes32 fullHash = factory.accountCodeHash();
        vm.expectRevert(ConsumerAccountFactory.InvalidCode.selector);
        new ConsumerAccountFactory(chunks, fullHash, IPriceOracle(address(0)));
    }

    function test_chunksAreInertWhenCalled() public {
        (bool ok, bytes memory ret) = factory.codeChunks(0).call("");
        assertTrue(ok);
        assertEq(ret.length, 0);
    }
}
