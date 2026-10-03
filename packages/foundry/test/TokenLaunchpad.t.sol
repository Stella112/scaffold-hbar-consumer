// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { TokenLaunchpad } from "../contracts/TokenLaunchpad.sol";
import { MockHederaTokenService } from "./mocks/Mocks.sol";

/// Test-only creator that tries to re-enter graduate() when it receives the raise.
contract ReentrantCreator {
    TokenLaunchpad internal immutable pad;
    uint256 public id;
    uint256 public received;
    bool public reentryBlocked;

    constructor(TokenLaunchpad pad_) {
        pad = pad_;
    }

    function launch(TokenLaunchpad.LaunchParams calldata p) external payable {
        (id,) = pad.launch{ value: msg.value }(p);
    }

    receive() external payable {
        received += msg.value;
        if (msg.sender == address(pad)) {
            try pad.graduate(id) {
                reentryBlocked = false;
            } catch {
                reentryBlocked = true;
            }
        }
    }
}

contract TokenLaunchpadTest is Test {
    TokenLaunchpad internal pad;
    MockHederaTokenService internal hts;
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // 1,000,000 DEMO (2 decimals); 600,000 for sale at 0.01 HBAR each; graduate at 1 HBAR raised.
    uint64 internal constant SUPPLY = 1_000_000_00;
    uint64 internal constant FOR_SALE = 600_000_00;
    uint128 internal constant PRICE = 1_000_000; // tinybars per whole token
    uint128 internal constant TARGET = 100_000_000; // 1 HBAR

    function setUp() public {
        vm.warp(1_800_000_000);
        MockHederaTokenService impl = new MockHederaTokenService();
        vm.etch(address(0x167), address(impl).code);
        hts = MockHederaTokenService(address(0x167));
        vm.store(address(0x167), bytes32(0), bytes32(uint256(22)));
        vm.deal(address(0x167), 0);
        pad = new TokenLaunchpad();
        vm.deal(creator, 100e8);
        vm.deal(alice, 100e8);
        vm.deal(bob, 100e8);
    }

    function _params() internal pure returns (TokenLaunchpad.LaunchParams memory) {
        return TokenLaunchpad.LaunchParams({
            name: "Demo",
            symbol: "DEMO",
            decimals: 2,
            supply: SUPPLY,
            forSale: FOR_SALE,
            priceTinybars: PRICE,
            target: TARGET,
            duration: 1 hours
        });
    }

    function _launch() internal returns (uint256 id, address token) {
        vm.prank(creator);
        (id, token) = pad.launch{ value: 15e8 }(_params());
    }

    function _buy(address who, uint64 amount) internal {
        uint256 cost = pad.quote(0, amount);
        vm.prank(who);
        pad.buy{ value: cost }(0, amount);
    }

    function test_launchCreatesImmutableFixedSupplyTokenAndRefundsUnspentFee() public {
        (uint256 id, address token) = _launch();
        assertEq(id, 0);
        assertTrue(token != address(0));
        assertEq(hts.lastTreasury(), address(pad));
        assertTrue(hts.lastFiniteSupply());
        assertEq(hts.lastMaxSupply(), int64(SUPPLY));
        assertEq(hts.lastInitialSupply(), int64(SUPPLY));
        assertEq(hts.lastKeyCount(), 0); // no admin / supply / freeze / wipe / pause keys
        assertEq(creator.balance, 100e8 - hts.CREATE_FEE()); // 5 HBAR of the 15 sent came back
        assertEq(address(pad).balance, 0);
    }

    function test_launchRejectsInvalidParams() public {
        TokenLaunchpad.LaunchParams memory p = _params();
        p.forSale = SUPPLY + 1;
        vm.prank(creator);
        vm.expectRevert(TokenLaunchpad.InvalidLaunch.selector);
        pad.launch{ value: 15e8 }(p);

        p = _params();
        p.duration = 59;
        vm.prank(creator);
        vm.expectRevert(TokenLaunchpad.InvalidLaunch.selector);
        pad.launch{ value: 15e8 }(p);

        p = _params();
        p.target = uint128(uint256(FOR_SALE) * PRICE / 100) + 1; // unreachable even if sold out
        vm.prank(creator);
        vm.expectRevert(TokenLaunchpad.InvalidLaunch.selector);
        pad.launch{ value: 15e8 }(p);
    }

    function test_launchFailsWhenHtsRejects() public {
        vm.store(address(0x167), bytes32(0), bytes32(uint256(7)));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TokenLaunchpad.HtsCallFailed.selector, int64(7)));
        pad.launch{ value: 15e8 }(_params());
    }

    function test_buyRequiresExactPaymentAndRespectsSupply() public {
        _launch();
        uint256 cost = pad.quote(0, 100_00); // 100 tokens = 1 HBAR
        assertEq(cost, 1e8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenLaunchpad.WrongPayment.selector, cost));
        pad.buy{ value: cost - 1 }(0, 100_00);

        uint256 all = pad.quote(0, FOR_SALE + 1);
        vm.deal(alice, all);
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.SoldOut.selector);
        pad.buy{ value: all }(0, FOR_SALE + 1);

        vm.deal(alice, 100e8);
        _buy(alice, 100_00);
        assertEq(pad.bought(0, alice), 100_00);
        assertEq(pad.paid(0, alice), 1e8);
    }

    function test_quoteRoundsUp() public {
        _launch();
        // 1 smallest unit = 0.01 token = 10,000 tinybars exactly; 1 unit at an odd price rounds up.
        assertEq(pad.quote(0, 1), 10_000);
    }

    function test_graduateOnlyAfterTargetAndExactlyOnce() public {
        _launch();
        _buy(alice, 60_00); // 0.6 HBAR
        vm.expectRevert(TokenLaunchpad.TargetNotReached.selector);
        pad.graduate(0);

        _buy(bob, 40_00); // total 1 HBAR
        uint256 before = creator.balance;
        pad.graduate(0);
        assertEq(creator.balance - before, TARGET);
        vm.expectRevert(TokenLaunchpad.AlreadyGraduated.selector);
        pad.graduate(0);
        assertEq(creator.balance - before, TARGET); // invariant 19: no second payout

        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.SaleClosed.selector);
        pad.buy{ value: 1e6 }(0, 1_00);
    }

    function test_reentrantCreatorIsPaidOnce() public {
        ReentrantCreator evil = new ReentrantCreator(pad);
        vm.deal(address(evil), 0);
        evil.launch{ value: 15e8 }(_params());
        uint256 id = evil.id();
        uint256 cost = pad.quote(id, 100_00);
        vm.prank(alice);
        pad.buy{ value: cost }(id, 100_00);
        uint256 refundedFee = address(evil).balance; // unspent creation fee
        pad.graduate(id);
        assertTrue(evil.reentryBlocked());
        assertEq(address(evil).balance - refundedFee, TARGET);
    }

    function test_claimsAfterGraduationViaAirdrop() public {
        (, address token) = _launch();
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.NotGraduated.selector);
        pad.claim(0);

        _buy(alice, 100_00);
        pad.graduate(0);

        vm.prank(alice);
        pad.claim(0);
        assertEq(hts.lastToken(), token);
        assertEq(hts.lastSender(), address(pad));
        assertEq(hts.lastReceiver(), alice);
        assertEq(hts.lastAmount(), int64(100_00));
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.NothingToClaim.selector);
        pad.claim(0);

        vm.prank(creator);
        pad.claim(0);
        assertEq(hts.lastReceiver(), creator);
        assertEq(hts.lastAmount(), int64(SUPPLY - 100_00)); // unsold + retained supply
        vm.prank(creator);
        vm.expectRevert(TokenLaunchpad.NothingToClaim.selector);
        pad.claim(0);
    }

    function test_claimRefundsUnspentFeeAndFailsWithoutFeeFunds() public {
        _launch();
        _buy(alice, 100_00);
        pad.graduate(0);
        hts.setAirdropFeeRequired(1e8); // the launchpad must hold 1 HBAR when it airdrops
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenLaunchpad.HtsCallFailed.selector, int64(10)));
        pad.claim(0); // no fee sent and the launchpad holds nothing

        uint256 before = alice.balance;
        vm.prank(alice);
        pad.claim{ value: 2e8 }(0);
        assertEq(before - alice.balance, 0); // mock spends nothing, so all 2 HBAR comes back
        assertEq(address(pad).balance, 0);
    }

    function test_refundsWhenDeadlinePassesBelowTarget() public {
        _launch();
        _buy(alice, 50_00); // 0.5 HBAR, target missed
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.RefundsClosed.selector);
        pad.refund(0); // still open

        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        vm.expectRevert(TokenLaunchpad.SaleClosed.selector);
        pad.buy{ value: 1e6 }(0, 1_00);

        uint256 before = alice.balance;
        vm.prank(alice);
        pad.refund(0);
        assertEq(alice.balance - before, 5e7);
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.NothingToClaim.selector);
        pad.refund(0);

        vm.expectRevert(TokenLaunchpad.TargetNotReached.selector);
        pad.graduate(0);
    }

    function test_noRefundsOnceTargetReached() public {
        _launch();
        _buy(alice, 100_00);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.RefundsClosed.selector);
        pad.refund(0);
    }

    function test_onlyHtsCanSendHbarDirectly() public {
        vm.prank(alice);
        (bool ok,) = address(pad).call{ value: 1e8 }("");
        assertFalse(ok);
    }

    function test_unknownLaunchReverts() public {
        vm.expectRevert(TokenLaunchpad.UnknownLaunch.selector);
        pad.graduate(3);
    }
}
