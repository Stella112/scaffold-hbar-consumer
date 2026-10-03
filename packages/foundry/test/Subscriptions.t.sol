// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { Actions } from "../contracts/Actions.sol";
import { MockScheduleService } from "./mocks/Mocks.sol";
import { AccountFixture } from "./ConsumerAccount.t.sol";

/// Recurring payments through the Hedera Schedule Service (HIP-1215), with a test-only HSS at 0x16b.
contract SubscriptionsTest is AccountFixture {
    MockScheduleService internal hss;
    uint64 internal constant INTERVAL = 1 hours;

    function setUp() public override {
        super.setUp();
        MockScheduleService impl = new MockScheduleService();
        vm.etch(address(0x16b), address(impl).code);
        hss = MockScheduleService(address(0x16b));
        vm.store(address(0x16b), bytes32(0), bytes32(uint256(22))); // responseCode = SUCCESS
    }

    function _create(address asset, uint128 amount, uint32 count) internal returns (uint256 id) {
        _ownerSelfCall(
            abi.encodeCall(
                ConsumerAccount.createSubscription,
                (asset, merchant, amount, INTERVAL, uint64(block.timestamp + 60), count, 400_000)
            )
        );
        id = account.subscriptionCount();
    }

    function test_createSchedulesFirstExecutionWithHss() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        assertEq(id, 1);
        assertEq(hss.calls(), 1);
        assertEq(hss.lastTo(), address(account));
        assertEq(hss.lastExpiry(), block.timestamp + 60 + account.SCHEDULE_BUFFER());
        assertEq(hss.lastGas(), 400_000);
        assertEq(hss.lastData(), abi.encodeCall(ConsumerAccount.executeSubscription, (id)));
        (,,,,, uint32 remaining,, address schedule) = account.subscriptions(id);
        assertEq(remaining, 3);
        assertTrue(schedule != address(0));
    }

    function test_executeBeforeDueReverts() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        vm.expectRevert(ConsumerAccount.SubscriptionNotDue.selector);
        account.executeSubscription(id);
    }

    function test_executePaysAndReschedules() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        vm.warp(block.timestamp + 60);
        vm.prank(stranger); // permissionless: whoever triggers it, only the configured payment happens
        account.executeSubscription(id);
        assertEq(usdc.balanceOf(merchant), 2e6);
        (,,,, uint64 nextAt, uint32 remaining,,) = account.subscriptions(id);
        assertEq(remaining, 2);
        assertEq(nextAt, block.timestamp + INTERVAL);
        assertEq(hss.calls(), 2);
        assertEq(hss.lastExpiry(), block.timestamp + INTERVAL + account.SCHEDULE_BUFFER());
    }

    function test_cannotPayTwiceForOneInstalment() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        vm.warp(block.timestamp + 60);
        account.executeSubscription(id);
        vm.expectRevert(ConsumerAccount.SubscriptionNotDue.selector);
        account.executeSubscription(id);
        assertEq(usdc.balanceOf(merchant), 2e6);
    }

    function test_lastInstalmentDoesNotReschedule() public {
        uint256 id = _create(address(0), 1e8, 1); // 1 HBAR once
        vm.warp(block.timestamp + 60);
        account.executeSubscription(id);
        assertEq(merchant.balance, 1e8);
        assertEq(hss.calls(), 1);
        vm.warp(block.timestamp + INTERVAL);
        vm.expectRevert(ConsumerAccount.SubscriptionInactive.selector);
        account.executeSubscription(id);
    }

    function test_reschedulingFailureNeverBlocksThePayment() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        vm.store(address(0x16b), bytes32(0), bytes32(uint256(7))); // non-SUCCESS response code
        vm.warp(block.timestamp + 60);
        vm.expectEmit(true, false, false, true, address(account));
        emit ConsumerAccount.SubscriptionScheduleFailed(id, 7);
        account.executeSubscription(id);
        assertEq(usdc.balanceOf(merchant), 2e6);
        // The next instalment can still be triggered manually once due.
        vm.warp(block.timestamp + INTERVAL);
        account.executeSubscription(id);
        assertEq(usdc.balanceOf(merchant), 4e6);
    }

    function test_createFailsWhenHssRejects() public {
        vm.store(address(0x16b), bytes32(0), bytes32(uint256(7)));
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(
            _call(
                address(account),
                0,
                abi.encodeCall(
                    ConsumerAccount.createSubscription,
                    (address(usdc), merchant, 1e6, INTERVAL, uint64(block.timestamp + 60), 2, 400_000)
                )
            )
        );
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert(); // CallFailed(0, ScheduleFailed(7))
        account.executeOwnerIntent(intent, sig);
        assertEq(account.subscriptionCount(), 0);
    }

    function test_cancelStopsPaymentsAndDeletesSchedule() public {
        uint256 id = _create(address(usdc), 2e6, 3);
        (,,,,,,, address schedule) = account.subscriptions(id);
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.cancelSubscription, (id)));
        assertEq(hss.lastDeleted(), schedule);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(ConsumerAccount.SubscriptionInactive.selector);
        account.executeSubscription(id);
    }

    function test_onlyOwnerCanCreateOrCancel() public {
        vm.prank(sessionKey);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.createSubscription(address(usdc), sessionKey, 1e6, INTERVAL, uint64(block.timestamp + 60), 1, 400_000);
        uint256 id = _create(address(usdc), 2e6, 3);
        vm.prank(stranger);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.cancelSubscription(id);
    }

    function test_sessionCannotReachSubscriptionsThroughActions() public {
        _grantDefaultSession();
        ConsumerAccount.SessionAction memory a = _action(Actions.ADMIN_SET_OWNER, "");
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PrivilegeEscalation.selector);
        account.executeSessionAction(a, sig);
    }

    function test_rejectsBadConfig() public {
        uint64 soon = uint64(block.timestamp + 60);
        bytes[5] memory bad = [
            abi.encodeCall(
                ConsumerAccount.createSubscription, (address(usdc), address(0), 1, INTERVAL, soon, 1, 400_000)
            ),
            abi.encodeCall(
                ConsumerAccount.createSubscription, (address(usdc), merchant, 0, INTERVAL, soon, 1, 400_000)
            ),
            abi.encodeCall(ConsumerAccount.createSubscription, (address(usdc), merchant, 1, 59, soon, 1, 400_000)),
            abi.encodeCall(
                ConsumerAccount.createSubscription,
                (address(usdc), merchant, 1, INTERVAL, uint64(block.timestamp), 1, 400_000)
            ),
            abi.encodeCall(ConsumerAccount.createSubscription, (address(usdc), merchant, 1, INTERVAL, soon, 1, 50_000))
        ];
        for (uint256 i; i < bad.length; ++i) {
            ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(address(account), 0, bad[i]));
            bytes memory sig = _signOwner(account, intent, ownerPk);
            vm.expectRevert();
            account.executeOwnerIntent(intent, sig);
        }
        assertEq(account.subscriptionCount(), 0);
    }
}
