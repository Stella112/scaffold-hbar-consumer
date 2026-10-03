// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AccountFixture } from "./ConsumerAccount.t.sol";
import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { Actions } from "../contracts/Actions.sol";
import { MockERC20, MockSwapRouter } from "./mocks/Mocks.sol";

contract SwapToPayTest is AccountFixture {
    MockERC20 internal sauce;
    MockSwapRouter internal router;

    function setUp() public override {
        super.setUp();
        sauce = new MockERC20("Test SAUCE", "TSAUCE", 6);
        sauce.mint(address(account), 1_000e6);
        oracle.setFeed(address(sauce), 50_000, 6); // $0.05 per SAUCE (test value)
        router = new MockSwapRouter(sauce, usdc, 21e6); // 21 SAUCE buys 1 USDC
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setSwapRouter, (address(router), true)));
    }

    function _path(address out, address in_) internal pure returns (bytes memory) {
        return abi.encodePacked(out, uint24(3000), in_);
    }

    function _params(uint256 maxIn) internal view returns (ConsumerAccount.SwapToPay memory) {
        return ConsumerAccount.SwapToPay({
            router: address(router),
            tokenIn: address(sauce),
            amountInMaximum: maxIn,
            tokenOut: address(usdc),
            amountOut: 1e6,
            to: merchant,
            deadline: block.timestamp + 120,
            path: _path(address(usdc), address(sauce))
        });
    }

    function _exec(ConsumerAccount.SwapToPay memory p, uint256 pk) internal {
        ConsumerAccount.SessionAction memory a = _action(Actions.SWAP_TO_PAY, abi.encode(p));
        account.executeSessionAction(a, _signAction(a, pk));
    }

    function _expectRevertExec(ConsumerAccount.SwapToPay memory p, uint256 pk, bytes memory err) internal {
        ConsumerAccount.SessionAction memory a = _action(Actions.SWAP_TO_PAY, abi.encode(p));
        bytes memory sig = _signAction(a, pk);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        account.executeSessionAction(a, sig);
    }

    function test_ownerSwapToPayDeliversExactOutput() public {
        _exec(_params(25e6), ownerPk);
        assertEq(usdc.balanceOf(merchant), 1e6);
        assertEq(sauce.balanceOf(address(account)), 1_000e6 - 21e6, "only the quoted input is spent");
        assertEq(sauce.allowance(address(account), address(router)), 0, "approval revoked");
    }

    function test_routerNotAllowlisted() public {
        ConsumerAccount.SwapToPay memory p = _params(25e6);
        p.router = makeAddr("evilRouter");
        _expectRevertExec(p, ownerPk, abi.encodeWithSelector(ConsumerAccount.TargetNotAllowed.selector));
    }

    function test_pathMustMatchTokens() public {
        ConsumerAccount.SwapToPay memory p = _params(25e6);
        p.path = _path(address(sauce), address(usdc));
        _expectRevertExec(p, ownerPk, abi.encodeWithSelector(ConsumerAccount.SwapPathMismatch.selector));
    }

    function test_staleDeadline() public {
        ConsumerAccount.SwapToPay memory p = _params(25e6);
        p.deadline = block.timestamp - 1;
        _expectRevertExec(p, ownerPk, abi.encodeWithSelector(ConsumerAccount.IntentExpired.selector));
    }

    function test_excessiveSlippageReverts() public {
        _expectRevertExec(_params(20e6), ownerPk, "");
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_underdeliveryCannotReportSuccess() public {
        router.setDeliverSkew(-1);
        _expectRevertExec(
            _params(25e6), ownerPk, abi.encodeWithSelector(ConsumerAccount.SwapUnderdelivered.selector, 1e6 - 1, 1e6)
        );
    }

    function test_overspendRejected() public {
        router.setIgnoreMax(true);
        _expectRevertExec(
            _params(25e6), ownerPk, abi.encodeWithSelector(ConsumerAccount.SwapOverspent.selector, 25e6 + 1, 25e6)
        );
    }

    function test_sessionSwapPricedAtMaxInput() public {
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = Actions.SWAP_TO_PAY;
        // Per-call cap $1.10. Caps price the worst case (amountInMaximum), not the eventual spend.
        _grant(sessionKey, actions, new address[](0), 1.1e6, 5e6, uint64(block.timestamp + 1 days));
        // 25 SAUCE max = $1.25 -> denied, although the router would only take 21 SAUCE.
        _expectRevertExec(_params(25e6), sessionPk, abi.encodeWithSelector(ConsumerAccount.PerCallCapExceeded.selector));
        // 21 SAUCE max = $1.05 -> allowed.
        _exec(_params(21e6), sessionPk);
        assertEq(usdc.balanceOf(merchant), 1e6);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 1.05e6);
    }

    function test_sessionCannotAllowlistRouter() public {
        _grantDefaultSession();
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(
            _call(address(account), 0, abi.encodeCall(ConsumerAccount.setSwapRouter, (makeAddr("evil"), true)))
        );
        bytes memory sig = _signOwner(account, intent, sessionPk);
        vm.expectRevert(ConsumerAccount.RawCallForbidden.selector);
        account.executeOwnerIntent(intent, sig);
    }
}
