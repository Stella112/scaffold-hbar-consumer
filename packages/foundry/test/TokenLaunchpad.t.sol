// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TokenLaunchpad } from "../contracts/TokenLaunchpad.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1.sol";
import {
    MockExchangeRate,
    MockHederaTokenService,
    MockSaucerSwapV1Factory,
    MockSaucerSwapV1Router
} from "./mocks/Mocks.sol";

/// Test-only creator that tries to re-enter graduate() when it receives its fee.
contract ReentrantCreator {
    TokenLaunchpad internal immutable pad;
    uint256 public id;
    bool public reentryBlocked;

    constructor(TokenLaunchpad pad_) {
        pad = pad_;
    }

    function launch(TokenLaunchpad.LaunchParams calldata p) external payable {
        (id,) = pad.launch{ value: msg.value }(p);
    }

    receive() external payable {
        if (msg.sender == address(pad)) {
            try pad.graduate(id) {
                reentryBlocked = false;
            } catch {
                reentryBlocked = true;
            }
        }
    }
}

/// Shared setup: mock HTS (0x167), exchange rate (0x168, 10¢/HBAR) and SaucerSwap V1 ($2 pool fee = 20 HBAR).
abstract contract LaunchpadFixture is Test {
    TokenLaunchpad internal pad;
    MockHederaTokenService internal hts;
    MockSaucerSwapV1Factory internal dex;
    MockSaucerSwapV1Router internal router;
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal constant WHBAR = address(0x3ad2);

    // 1,000,000 DEMO (2 decimals); 600,000 on a curve from 0.01 to 0.03 HBAR; graduate at 30 HBAR; 5% creator fee.
    uint64 internal constant SUPPLY = 1_000_000_00;
    uint64 internal constant CURVE = 600_000_00;
    uint128 internal constant P0 = 1_000_000;
    uint128 internal constant P1 = 3_000_000;
    uint128 internal constant TARGET = 30e8;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.etch(address(0x167), address(new MockHederaTokenService()).code);
        hts = MockHederaTokenService(address(0x167));
        vm.store(address(0x167), bytes32(0), bytes32(uint256(22)));
        vm.etch(address(0x168), address(new MockExchangeRate()).code);
        dex = new MockSaucerSwapV1Factory();
        router = new MockSaucerSwapV1Router(dex, WHBAR);
        pad = new TokenLaunchpad(ISaucerSwapV1Router(address(router)));
        vm.deal(creator, 1000e8);
        vm.deal(alice, 1e15);
        vm.deal(bob, 1000e8);
    }

    function _params() internal pure returns (TokenLaunchpad.LaunchParams memory) {
        return TokenLaunchpad.LaunchParams({
            name: "Demo",
            symbol: "DEMO",
            decimals: 2,
            supply: SUPPLY,
            curveSupply: CURVE,
            startPrice: P0,
            endPrice: P1,
            target: TARGET,
            creatorFeeBps: 500,
            duration: 1 hours
        });
    }

    function _launch() internal returns (uint256 id, address token) {
        vm.prank(creator);
        (id, token) = pad.launch{ value: 15e8 }(_params());
    }

    function _buy(address who, uint64 amount) internal returns (uint256 cost) {
        cost = pad.quote(0, amount);
        vm.prank(who);
        pad.buy{ value: cost }(0, amount);
    }
}

contract TokenLaunchpadTest is LaunchpadFixture {
    function test_launchCreatesImmutableFixedSupplyTokenAndRefundsUnspentFee() public {
        (uint256 id, address token) = _launch();
        assertEq(id, 0);
        assertEq(IERC20(token).balanceOf(address(pad)), SUPPLY); // launchpad is treasury
        assertEq(hts.lastTreasury(), address(pad));
        assertTrue(hts.lastFiniteSupply());
        assertEq(hts.lastMaxSupply(), int64(SUPPLY));
        assertEq(hts.lastKeyCount(), 0); // no admin / supply / freeze / wipe / pause keys
        assertEq(creator.balance, 1000e8 - hts.CREATE_FEE()); // 5 of the 15 HBAR sent came back
        assertEq(address(pad).balance, 0);
    }

    function test_launchRejectsInvalidParams() public {
        TokenLaunchpad.LaunchParams[5] memory bad;
        for (uint256 i; i < 5; ++i) {
            bad[i] = _params();
        }
        bad[0].curveSupply = SUPPLY; // nothing left for the pool
        bad[1].endPrice = P0 - 1; // decreasing curve
        bad[2].target = 1e18; // unreachable even if sold out
        bad[3].creatorFeeBps = 1001;
        bad[4].duration = 59;
        for (uint256 i; i < 5; ++i) {
            vm.prank(creator);
            vm.expectRevert(TokenLaunchpad.InvalidLaunch.selector);
            pad.launch{ value: 15e8 }(bad[i]);
        }
    }

    function test_priceRisesAlongTheCurve() public {
        _launch();
        assertEq(pad.currentPrice(0), P0);
        uint256 first = pad.quote(0, 10_000_00); // 10,000 tokens
        _buy(alice, 300_000_00); // half the curve
        assertEq(pad.currentPrice(0), (P0 + P1) / 2);
        assertGt(pad.quote(0, 10_000_00), first);
        _buy(alice, 300_000_00);
        assertEq(pad.currentPrice(0), P1);
    }

    function test_exactCurveCost() public {
        _launch();
        // First 100 tokens: 100 × 0.01 + 2e6 × 100 × 100 / (2 × 600,000) tinybars = 1e8 + 16,667 (rounded up)
        assertEq(pad.quote(0, 100_00), 100_016_667);
    }

    function test_buyRequiresExactPaymentAndRespectsCurveSupply() public {
        _launch();
        uint256 cost = pad.quote(0, 100_00);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenLaunchpad.WrongPayment.selector, cost));
        pad.buy{ value: cost - 1 }(0, 100_00);
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.SoldOut.selector);
        pad.buy{ value: 1 }(0, CURVE + 1);
    }

    function test_graduationSeedsSaucerSwapAtTheCurvePrice() public {
        (, address token) = _launch();
        _buy(alice, 1_500_00);
        _buy(bob, 1_500_00); // ≈ 30.2 HBAR raised
        TokenLaunchpad.Launch memory l = pad.launches(0);
        uint256 creatorBefore = creator.balance;
        uint256 price = pad.currentPrice(0);

        pad.graduate(0);

        TokenLaunchpad.Launch memory g = pad.launches(0);
        uint256 creatorFee = uint256(l.raised) * 500 / 10_000;
        uint256 poolHbar = l.raised - creatorFee - 20e8; // minus the $2 pool fee (20 HBAR at 10¢)
        assertTrue(g.graduated);
        assertEq(g.pair, dex.getPair(token, WHBAR));
        assertTrue(g.pair != address(0));
        assertEq(router.lastHbar(), poolHbar);
        assertEq(router.lastTo(), address(pad)); // LP stays locked in the launchpad
        assertEq(IERC20(token).balanceOf(g.pair), g.poolTokens);
        // Pool opens at the curve's price (within rounding).
        assertApproxEqRel(poolHbar * 100 / g.poolTokens, price, 0.001e18);
        assertEq(creator.balance - creatorBefore, creatorFee);
        assertEq(address(pad).balance, 0);
        vm.expectRevert(TokenLaunchpad.AlreadyGraduated.selector);
        pad.graduate(0);
    }

    function test_graduationAddsToAFrontRunPool() public {
        (, address token) = _launch();
        dex.createPair(token, WHBAR); // someone creates the pool first
        _buy(alice, 3_000_00);
        uint256 raised = pad.launches(0).raised;
        pad.graduate(0);
        assertEq(router.lastHbar(), raised - raised * 500 / 10_000); // no pool fee on the existing pool
        assertTrue(pad.launches(0).graduated);
    }

    function test_graduationNeedsMoreThanThePoolFee() public {
        TokenLaunchpad.LaunchParams memory p = _params();
        p.target = 10e8; // 10 HBAR raise cannot pay a 20 HBAR pool fee
        vm.prank(creator);
        pad.launch{ value: 15e8 }(p);
        _buy(alice, 1_000_00);
        vm.expectRevert();
        pad.graduate(0);
        assertFalse(pad.launches(0).graduated);
    }

    function test_reentrantCreatorIsPaidOnce() public {
        ReentrantCreator evil = new ReentrantCreator(pad);
        vm.deal(address(evil), 0);
        evil.launch{ value: 15e8 }(_params());
        _buy(alice, 3_000_00);
        uint256 raised = pad.launches(0).raised;
        uint256 refundedFee = address(evil).balance;
        pad.graduate(0);
        assertTrue(evil.reentryBlocked());
        assertEq(address(evil).balance - refundedFee, raised * 500 / 10_000);
    }

    function test_claimsAfterGraduation() public {
        (, address token) = _launch();
        vm.prank(alice);
        vm.expectRevert(TokenLaunchpad.NotGraduated.selector);
        pad.claim(0);
        _buy(alice, 3_000_00);
        pad.graduate(0);
        vm.prank(alice);
        pad.claim(0);
        assertEq(hts.lastToken(), token);
        assertEq(hts.lastReceiver(), alice);
        assertEq(hts.lastAmount(), int64(3_000_00));
        vm.prank(creator);
        pad.claim(0);
        TokenLaunchpad.Launch memory l = pad.launches(0);
        assertEq(hts.lastAmount(), int64(SUPPLY - l.sold - l.poolTokens)); // unsold curve + unused reserve
        vm.prank(creator);
        vm.expectRevert(TokenLaunchpad.NothingToClaim.selector);
        pad.claim(0);
    }

    function test_refundsWhenDeadlinePassesBelowTarget() public {
        _launch();
        uint256 cost = _buy(alice, 1_000_00);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.refund(0);
        assertEq(alice.balance - before, cost);
        vm.expectRevert(TokenLaunchpad.TargetNotReached.selector);
        pad.graduate(0);
    }

    function test_onlyHtsAndRouterCanSendHbar() public {
        vm.prank(alice);
        (bool ok,) = address(pad).call{ value: 1e8 }("");
        assertFalse(ok);
    }

    function testFuzz_curveCostIsAdditiveAndMonotonic(uint64 a, uint64 b) public {
        _launch();
        a = uint64(bound(a, 1, CURVE / 2));
        b = uint64(bound(b, 1, CURVE / 2));
        uint256 together = pad.quote(0, a + b);
        uint256 first = _buy(alice, a);
        uint256 second = pad.quote(0, b);
        // Splitting a purchase never saves more than one tinybar per part (rounding up).
        assertGe(first + second, together);
        assertLe(first + second, together + 2);
    }
}
