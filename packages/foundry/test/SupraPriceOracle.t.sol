// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SupraPriceOracle } from "../contracts/SupraPriceOracle.sol";
import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { Actions } from "../contracts/Actions.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../contracts/interfaces/ISupraSValueFeed.sol";
import { MockSupraFeed } from "./mocks/Mocks.sol";
import { AccountFixture } from "./ConsumerAccount.t.sol";

contract SupraPriceOracleTest is Test {
    uint64 internal constant HBAR_USD = 432;
    uint64 internal constant USDC_USD = 89;
    address internal constant USDC = address(0x1549);

    MockSupraFeed internal feed;
    SupraPriceOracle internal oracle;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockSupraFeed();
        feed.set(HBAR_USD, 0.1016e18, 18, block.timestamp * 1000); // $0.1016
        feed.set(USDC_USD, 0.99999e8, 8, block.timestamp * 1000); // $0.99999
        oracle = _deploy(2 hours);
    }

    function _deploy(uint256 maxAge) internal returns (SupraPriceOracle) {
        address[] memory a = new address[](2);
        uint64[] memory p = new uint64[](2);
        uint8[] memory d = new uint8[](2);
        (a[0], p[0], d[0]) = (address(0), HBAR_USD, 8);
        (a[1], p[1], d[1]) = (USDC, USDC_USD, 6);
        return new SupraPriceOracle(ISupraSValueFeed(address(feed)), maxAge, a, p, d);
    }

    function test_quotesHbarInTinybars() public view {
        (bool ok, uint256 usd6) = oracle.quoteUsd6(address(0), 10e8); // 10 HBAR
        assertTrue(ok);
        assertEq(usd6, 1_016_000); // $1.016
    }

    function test_quotesTokenWithOwnDecimals() public view {
        (bool ok, uint256 usd6) = oracle.quoteUsd6(USDC, 5e6); // 5 USDC
        assertTrue(ok);
        assertEq(usd6, 4_999_950);
    }

    function test_roundsUpSoCapsAreNeverUndercharged() public view {
        (bool ok, uint256 usd6) = oracle.quoteUsd6(address(0), 1); // 1 tinybar ≈ $0.000000001016
        assertTrue(ok);
        assertEq(usd6, 1);
    }

    function test_zeroAmountIsZero() public view {
        (bool ok, uint256 usd6) = oracle.quoteUsd6(address(0), 0);
        assertTrue(ok);
        assertEq(usd6, 0);
    }

    function test_unsupportedAssetFailsClosed() public view {
        (bool ok, uint256 usd6) = oracle.quoteUsd6(address(0xBEEF), 1e8);
        assertFalse(ok);
        assertEq(usd6, 0);
    }

    function test_stalePriceFailsClosed() public {
        vm.warp(block.timestamp + 2 hours + 1);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
    }

    function test_priceAtMaxAgeIsAccepted() public {
        vm.warp(block.timestamp + 2 hours);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertTrue(ok);
    }

    function test_futureTimestampFailsClosed() public {
        feed.set(HBAR_USD, 0.1e18, 18, (block.timestamp + 61) * 1000);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
    }

    function test_zeroPriceFailsClosed() public {
        feed.set(HBAR_USD, 0, 18, block.timestamp * 1000);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
    }

    function test_absurdPriceOrDecimalsFailClosed() public {
        feed.set(HBAR_USD, 1e41, 18, block.timestamp * 1000);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
        feed.set(HBAR_USD, 1, 37, block.timestamp * 1000);
        (ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
    }

    function test_revertingFeedFailsClosed() public {
        feed.setReverts(true);
        (bool ok,) = oracle.quoteUsd6(address(0), 1e8);
        assertFalse(ok);
    }

    function test_constructorRejectsBadConfig() public {
        address[] memory a = new address[](1);
        uint64[] memory p = new uint64[](2);
        uint8[] memory d = new uint8[](1);
        vm.expectRevert(SupraPriceOracle.LengthMismatch.selector);
        new SupraPriceOracle(ISupraSValueFeed(address(feed)), 1 hours, a, p, d);
        vm.expectRevert(SupraPriceOracle.InvalidConfig.selector);
        new SupraPriceOracle(ISupraSValueFeed(address(0)), 1 hours, new address[](0), new uint64[](0), new uint8[](0));
        vm.expectRevert(SupraPriceOracle.InvalidConfig.selector);
        new SupraPriceOracle(ISupraSValueFeed(address(feed)), 0, new address[](0), new uint64[](0), new uint8[](0));
    }

    function testFuzz_quoteNeverUndershoots(uint64 amount, uint64 price) public {
        vm.assume(price > 0);
        feed.set(HBAR_USD, price, 8, block.timestamp * 1000);
        (bool ok, uint256 usd6) = oracle.quoteUsd6(address(0), amount);
        assertTrue(ok);
        // usd6 * 1e16 >= amount * price (exact value scaled), and within one unit of it.
        uint256 exact = uint256(amount) * price;
        assertGe(usd6 * 1e10, exact);
        assertLt(usd6 * 1e10, exact + 1e10);
    }
}

/// Session caps priced by the real adapter (over a mock feed) inside ConsumerAccount.
contract SupraSessionCapsTest is AccountFixture {
    MockSupraFeed internal feed;

    function setUp() public override {
        super.setUp();
        feed = new MockSupraFeed();
        feed.set(432, 0.1e18, 18, block.timestamp * 1000); // HBAR = $0.10
        address[] memory a = new address[](1);
        uint64[] memory p = new uint64[](1);
        uint8[] memory d = new uint8[](1);
        (a[0], p[0], d[0]) = (address(0), 432, 8);
        SupraPriceOracle supra = new SupraPriceOracle(ISupraSValueFeed(address(feed)), 2 hours, a, p, d);
        vm.prank(address(account));
        account.setOracle(IPriceOracle(address(supra)));
        _grantDefaultSession(); // $10 per call, $25 per day
    }

    function _payHbar(uint256 tinybars) internal {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(0), merchant, tinybars));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
    }

    function test_hbarPaymentWithinCapIsCharged() public {
        _payHbar(50e8); // 50 HBAR = $5
        assertEq(merchant.balance, 50e8);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 5e6);
    }

    function test_perCallCapUsesLivePrice() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(0), merchant, 101e8)); // $10.10
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_stalePriceDeniesSessionSpend() public {
        vm.warp(block.timestamp + 3 hours);
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(0), merchant, 1e8));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PriceUnavailable.selector);
        account.executeSessionAction(a, sig);
    }
}
