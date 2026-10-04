// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ConsumerAccount } from "../../contracts/ConsumerAccount.sol";
import { Actions } from "../../contracts/Actions.sol";
import { MockERC20 } from "../mocks/Mocks.sol";
import { AccountFixture } from "../ConsumerAccount.t.sol";

/// Drives an agent session with random actions. Every call either succeeds within policy or reverts; the ghost
/// variables record what actually left the account so the invariants can compare it with the policy.
contract SessionHandler is Test {
    ConsumerAccount internal immutable account;
    MockERC20 internal immutable usdc;
    uint256 internal immutable sessionPk;
    address internal immutable merchant;
    address[] internal targets;

    uint256 public nonce = 1_000_000;
    uint256 public succeeded;
    uint256 public privilegedAccepted;
    /// day => USD6 paid out by successful session payments (TUSD is $1, HBAR $0.05 in the fixture)
    mapping(uint256 => uint256) public paidUsd6ByDay;
    uint256[] public daysSeen;

    constructor(ConsumerAccount account_, MockERC20 usdc_, uint256 sessionPk_, address merchant_, address stranger) {
        account = account_;
        usdc = usdc_;
        sessionPk = sessionPk_;
        merchant = merchant_;
        targets.push(merchant_);
        targets.push(stranger);
        targets.push(address(this));
    }

    function _send(bytes32 id, bytes memory data) internal returns (bool ok) {
        ConsumerAccount.SessionAction memory a = ConsumerAccount.SessionAction({
            actionId: id, actionData: data, nonce: nonce++, validUntil: uint64(block.timestamp + 300)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, account.hashSessionAction(a));
        try account.executeSessionAction(a, abi.encodePacked(r, s, v)) {
            ok = true;
        } catch { }
    }

    function payToken(uint256 amount, uint8 target) external {
        amount = bound(amount, 1, 30e6); // up to $30 against a $10 per-call / $25 daily cap
        address to = targets[target % targets.length];
        if (_send(Actions.PAYMENT, abi.encode(address(usdc), to, amount))) {
            succeeded++;
            _record(amount);
        }
    }

    function payHbar(uint256 tinybars, uint8 target) external {
        tinybars = bound(tinybars, 1, 300e8); // up to 300 HBAR = $15
        address to = targets[target % targets.length];
        if (_send(Actions.PAYMENT, abi.encode(address(0), to, tinybars))) {
            succeeded++;
            _record((tinybars * 50_000) / 1e8); // same valuation as the fixture oracle (rounds down)
        }
    }

    function tryPrivileged(uint8 which) external {
        bytes32[4] memory ids =
            [Actions.ADMIN_SET_OWNER, Actions.ADMIN_GRANT_SESSION, Actions.VAULT_WITHDRAW, Actions.ADMIN_SET_GUARDIANS];
        if (_send(ids[which % 4], abi.encode(address(this)))) privilegedAccepted++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
    }

    function _record(uint256 usd6) internal {
        uint256 day = block.timestamp / 1 days;
        if (paidUsd6ByDay[day] == 0) daysSeen.push(day);
        paidUsd6ByDay[day] += usd6;
    }

    function dayCount() external view returns (uint256) {
        return daysSeen.length;
    }
}

contract SessionInvariantsTest is AccountFixture {
    SessionHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory recipients = new address[](1);
        recipients[0] = merchant;
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = Actions.PAYMENT;
        // $10 per call, $25 per day, merchant only, valid for the whole run
        _grant(sessionKey, actions, recipients, 10e6, 25e6, uint64(block.timestamp + 3650 days));
        usdc.mint(address(account), 1_000_000e6);
        vm.deal(address(account), 1_000_000e8);
        handler = new SessionHandler(account, usdc, sessionPk, merchant, stranger);
        targetContract(address(handler));
    }

    /// The owner can only change through the owner path; an agent session never moves it.
    function invariant_ownerNeverChanges() public view {
        assertEq(account.owner(), ownerAddr);
    }

    /// Reserved admin / withdrawal actions are never accepted from a session.
    function invariant_noPrivilegedActionEverSucceeds() public view {
        assertEq(handler.privilegedAccepted(), 0);
    }

    /// Nothing ever reaches a recipient outside the session's allowlist.
    function invariant_onlyAllowlistedRecipientsArePaid() public view {
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(stranger.balance, 0);
        assertEq(usdc.balanceOf(address(handler)), 0);
        assertEq(address(handler).balance, 0);
    }

    /// Per UTC day, successful session spend never exceeds the daily cap, and the account's own accounting agrees.
    function invariant_dailyCapHolds() public view {
        for (uint256 i; i < handler.dayCount(); ++i) {
            assertLe(handler.paidUsd6ByDay(handler.daysSeen(i)), 25e6);
        }
        assertLe(account.getSession(sessionKey).spentTodayUsd6, 25e6);
    }
}
