// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { Actions } from "../contracts/Actions.sol";
import { TokenLaunchpad } from "../contracts/TokenLaunchpad.sol";
import { LaunchpadBuyAction } from "../contracts/actions/LaunchpadBuyAction.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1.sol";
import {
    MockExchangeRate,
    MockSaucerSwapV1Factory,
    MockSaucerSwapV1Router,
    MockTransferModule
} from "./mocks/Mocks.sol";
import { AccountFixture } from "./ConsumerAccount.t.sol";

/// Custom typed actions through owner-installed planner modules.
contract ActionModulesTest is AccountFixture {
    bytes32 internal constant CUSTOM = keccak256("consumer.action.test-transfer.v1");
    MockTransferModule internal module;

    function setUp() public override {
        super.setUp();
        module = new MockTransferModule(address(usdc));
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setActionModule, (CUSTOM, address(module))));
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = CUSTOM;
        _grant(sessionKey, actions, new address[](0), 10e6, 25e6, uint64(block.timestamp + 1 days));
    }

    function test_sessionRunsModuleWithinCaps() public {
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(merchant, uint256(5e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
        assertEq(usdc.balanceOf(merchant), 5e6);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 5e6);
    }

    function test_declaredSpendIsCapped() public {
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(merchant, uint256(11e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_moduleCannotSpendMoreThanDeclared() public {
        module.setLie(3, false); // declares 1 TUSD, transfers 3
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(merchant, uint256(1e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_moduleCannotCallTheAccount() public {
        module.setLie(1, true); // tries setOwner through a self-call
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(stranger, uint256(1e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.TargetNotAllowed.selector);
        account.executeSessionAction(a, sig);
        assertEq(account.owner(), ownerAddr);
    }

    function test_sessionWithoutTheActionIsDenied() public {
        _grantDefaultSession();
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(merchant, uint256(1e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_cannotOverrideBuiltinOrReservedIds() public {
        bytes32[4] memory ids =
            [Actions.PAYMENT, Actions.VAULT_DEPOSIT, Actions.ADMIN_SET_OWNER, Actions.VAULT_WITHDRAW];
        for (uint256 i; i < ids.length; ++i) {
            vm.prank(address(account));
            vm.expectRevert(ConsumerAccount.InvalidConfig.selector);
            account.setActionModule(ids[i], address(module));
        }
    }

    function test_onlyOwnerInstallsModules() public {
        vm.prank(sessionKey);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setActionModule(keccak256("x"), address(module));
    }

    function test_uninstalledModuleFailsClosed() public {
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setActionModule, (CUSTOM, address(0))));
        ConsumerAccount.SessionAction memory a = _action(CUSTOM, abi.encode(merchant, uint256(1e6)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }
}

/// launchpad-buy: an agent buys launch tokens with the account's HBAR, priced against its USD caps.
contract LaunchpadBuyActionTest is AccountFixture {
    TokenLaunchpad internal pad;
    LaunchpadBuyAction internal buyAction;

    function setUp() public override {
        super.setUp();
        vm.etch(address(0x168), address(new MockExchangeRate()).code);
        MockSaucerSwapV1Factory dex = new MockSaucerSwapV1Factory();
        pad = new TokenLaunchpad(ISaucerSwapV1Router(address(new MockSaucerSwapV1Router(dex, address(0x3ad2)))));
        buyAction = new LaunchpadBuyAction(pad);
        address creator = makeAddr("creator");
        vm.deal(creator, 100e8);
        vm.prank(creator);
        pad.launch{ value: 15e8 }(
            TokenLaunchpad.LaunchParams({
                name: "Demo",
                symbol: "DEMO",
                decimals: 2,
                supply: 1_000_000_00,
                curveSupply: 600_000_00,
                startPrice: 1_000_000,
                endPrice: 1_000_000, // flat curve: 0.01 HBAR per token
                target: 30e8,
                creatorFeeBps: 0,
                duration: 1 hours
            })
        );
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setActionModule, (buyAction.ID(), address(buyAction))));
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = buyAction.ID();
        _grant(sessionKey, actions, new address[](0), 1e6, 3e6, uint64(block.timestamp + 1 days)); // $1 / $3
    }

    function test_agentBuysWithinCaps() public {
        ConsumerAccount.SessionAction memory a =
            _action(buyAction.ID(), abi.encode(uint256(0), uint64(100_00), uint256(1e8)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
        assertEq(pad.bought(0, address(account)), 100_00); // 100 tokens = 1 HBAR = $0.05
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 0.05e6);
    }

    function test_agentBuyOverCapDenied() public {
        ConsumerAccount.SessionAction memory a =
            _action(buyAction.ID(), abi.encode(uint256(0), uint64(3000_00), uint256(100e8)));
        bytes memory sig = _signAction(a, sessionPk); // 30 HBAR = $1.50 > $1
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_maxCostProtectsAgainstPriceSurprises() public {
        ConsumerAccount.SessionAction memory a =
            _action(buyAction.ID(), abi.encode(uint256(0), uint64(100_00), uint256(1)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadBuyAction.CostAboveMaximum.selector, 1e8, 1));
        account.executeSessionAction(a, sig);
    }
}
