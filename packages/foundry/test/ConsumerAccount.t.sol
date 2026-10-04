// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ConsumerAccount } from "../contracts/ConsumerAccount.sol";
import { ConsumerAccountFactory } from "../contracts/ConsumerAccountFactory.sol";
import { AccountFactoryDeployer } from "../contracts/AccountFactoryDeployer.sol";
import { Actions } from "../contracts/Actions.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { MockERC20, MockOracle, MockHederaTokenService, CallTarget } from "./mocks/Mocks.sol";

/// Shared fixture: factory, account, mocks, signing helpers.
abstract contract AccountFixture is Test {
    ConsumerAccountFactory internal factory;
    ConsumerAccount internal account;
    MockERC20 internal usdc;
    MockOracle internal oracle;
    MockHederaTokenService internal hts;
    CallTarget internal target;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal sessionPk = 0xB0B;
    uint256 internal attackerPk = 0xBAD;
    address internal ownerAddr;
    address internal sessionKey;
    address internal relayer = makeAddr("relayer");
    address internal merchant = makeAddr("merchant");
    address internal stranger = makeAddr("stranger");

    uint256 internal nextNonce = 1;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        ownerAddr = vm.addr(ownerPk);
        sessionKey = vm.addr(sessionPk);

        usdc = new MockERC20("Test USD", "TUSD", 6);
        oracle = new MockOracle();
        oracle.setFeed(address(usdc), 1e6, 6); // 1 TUSD = $1.00
        oracle.setFeed(address(0), 50_000, 8); // 1 HBAR = $0.05 (test value)

        MockHederaTokenService htsImpl = new MockHederaTokenService();
        vm.etch(address(0x167), address(htsImpl).code);
        hts = MockHederaTokenService(address(0x167));
        vm.store(address(0x167), bytes32(0), bytes32(uint256(22))); // responseCode slot

        target = new CallTarget();
        factory = AccountFactoryDeployer.deploy(IPriceOracle(address(oracle)));
        account = factory.createAccount(ownerAddr, bytes32(0));

        usdc.mint(address(account), 1_000e6);
        vm.deal(address(account), 100e8);
    }

    // ------------------------------------------------------------ builders

    function _call(address to, uint256 value, bytes memory data)
        internal
        pure
        returns (ConsumerAccount.Call[] memory calls)
    {
        calls = new ConsumerAccount.Call[](1);
        calls[0] = ConsumerAccount.Call({ target: to, value: value, data: data });
    }

    function _ownerIntent(ConsumerAccount.Call[] memory calls)
        internal
        returns (ConsumerAccount.OwnerIntent memory intent)
    {
        intent = ConsumerAccount.OwnerIntent({
            calls: calls, nonce: nextNonce++, validUntil: uint64(block.timestamp + 300)
        });
    }

    function _signOwner(ConsumerAccount acct, ConsumerAccount.OwnerIntent memory intent, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.hashOwnerIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _action(bytes32 id, bytes memory data) internal returns (ConsumerAccount.SessionAction memory a) {
        a = ConsumerAccount.SessionAction({
            actionId: id, actionData: data, nonce: nextNonce++, validUntil: uint64(block.timestamp + 300)
        });
    }

    function _signAction(ConsumerAccount.SessionAction memory a, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, account.hashSessionAction(a));
        return abi.encodePacked(r, s, v);
    }

    function _pay(address asset, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encode(asset, to, amount);
    }

    /// Owner-signed self-call, submitted by the relayer.
    function _ownerSelfCall(bytes memory data) internal {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(address(account), 0, data));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.prank(relayer);
        account.executeOwnerIntent(intent, sig);
    }

    function _grantDefaultSession() internal {
        bytes32[] memory actions = new bytes32[](2);
        actions[0] = Actions.PAYMENT;
        actions[1] = Actions.X402_PAYMENT;
        _grant(sessionKey, actions, new address[](0), 10e6, 25e6, uint64(block.timestamp + 1 days));
    }

    function _grant(
        address key,
        bytes32[] memory actions,
        address[] memory recipients,
        uint128 perCall,
        uint128 daily,
        uint64 expiresAt
    ) internal {
        ConsumerAccount.SessionConfig memory cfg = ConsumerAccount.SessionConfig({
            key: key,
            expiresAt: expiresAt,
            perCallCapUsd6: perCall,
            dailyCapUsd6: daily,
            allowedActions: actions,
            allowedRecipients: recipients
        });
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.grantSession, (cfg)));
    }
}

contract OwnerIntentTest is AccountFixture {
    function test_relayerSubmitsOwnerSignedTokenPayment() public {
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, 10e6))));
        bytes memory sig = _signOwner(account, intent, ownerPk);

        assertEq(ownerAddr.balance, 0, "controller holds zero HBAR");
        vm.prank(relayer);
        account.executeOwnerIntent(intent, sig);
        assertEq(usdc.balanceOf(merchant), 10e6);
        assertTrue(account.nonceUsed(intent.nonce));
    }

    function test_ownerSignedHbarPayment() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 5e8, ""));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.prank(relayer);
        account.executeOwnerIntent(intent, sig);
        assertEq(merchant.balance, 5e8);
    }

    function test_relayerIdentityGrantsNothing() public {
        // The relayer calling with its own signature has no authority.
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sig = _signOwner(account, intent, attackerPk);
        vm.prank(relayer);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_wrongSignerFails() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sig = _signOwner(account, intent, attackerPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_exactReplayFails() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        account.executeOwnerIntent(intent, sig);
        vm.expectRevert(ConsumerAccount.IntentReplayed.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_expiredFails() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.warp(intent.validUntil + 1);
        vm.expectRevert(ConsumerAccount.IntentExpired.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_modifiedAmountRecipientTargetCalldataFail() public {
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, 10e6))));
        bytes memory sig = _signOwner(account, intent, ownerPk);

        ConsumerAccount.OwnerIntent memory tampered = intent;
        tampered.calls = _call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, 11e6)));
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(tampered, sig);

        tampered.calls = _call(address(usdc), 0, abi.encodeCall(usdc.transfer, (stranger, 10e6)));
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(tampered, sig);

        tampered.calls = _call(address(target), 0, abi.encodeCall(usdc.transfer, (merchant, 10e6)));
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(tampered, sig);

        tampered.calls = _call(address(usdc), 0, abi.encodeCall(usdc.approve, (merchant, 10e6)));
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(tampered, sig);

        tampered.calls = intent.calls;
        tampered.validUntil = intent.validUntil + 1;
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(tampered, sig);
    }

    function testFuzz_anyAmountTamperFails(uint256 amount) public {
        vm.assume(amount != 10e6);
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, 10e6))));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        intent.calls = _call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, amount)));
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_wrongAccountFails() public {
        ConsumerAccount other = factory.createAccount(ownerAddr, bytes32(uint256(1)));
        vm.deal(address(other), 10e8);
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sigForOther = _signOwner(other, intent, ownerPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(intent, sigForOther);
    }

    function test_wrongChainFails() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(merchant, 1e8, ""));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.chainId(295);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_rawHtsCallMustUseTypedHelper() public {
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(_call(address(0x167), 0, hex"01"));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert(ConsumerAccount.HtsCallMustBeTyped.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_failedInnerCallRevertsWholeIntentAndKeepsNonce() public {
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(usdc), 0, abi.encodeCall(usdc.transfer, (merchant, 1e30))));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert();
        account.executeOwnerIntent(intent, sig);
        assertFalse(account.nonceUsed(intent.nonce));
    }

    function test_associateTokenChecksResponseCode() public {
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.associateToken, (address(usdc))));
        assertEq(hts.associateCalls(), 1);

        hts.setResponseCode(184); // any non-SUCCESS code
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(account), 0, abi.encodeCall(ConsumerAccount.associateToken, (address(usdc)))));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert(); // CallFailed wrapping HtsCallFailed(184)
        account.executeOwnerIntent(intent, sig);
    }

    function test_adminFunctionsRejectDirectCalls() public {
        vm.startPrank(ownerAddr);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setOwner(stranger);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.revokeSession(sessionKey);
        vm.stopPrank();
    }
}

contract SessionPolicyTest is AccountFixture {
    function setUp() public override {
        super.setUp();
        _grantDefaultSession();
    }

    function test_sessionTypedPaymentWithinCaps() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 5e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.prank(relayer);
        account.executeSessionAction(a, sig);
        assertEq(usdc.balanceOf(merchant), 5e6);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 5e6);
    }

    function test_sessionRawCallForbiddenBeforeAnyInteraction() public {
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(target), 0, abi.encodeCall(CallTarget.hit, ())));
        bytes memory sig = _signOwner(account, intent, sessionPk);
        vm.expectRevert(ConsumerAccount.RawCallForbidden.selector);
        account.executeOwnerIntent(intent, sig);
        assertEq(target.hits(), 0);
    }

    function test_sessionExpired() public {
        vm.warp(block.timestamp + 1 days + 1);
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.SessionExpired.selector);
        account.executeSessionAction(a, sig);
    }

    function test_privilegeEscalationAction() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.ADMIN_SET_OWNER, abi.encode(sessionKey));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PrivilegeEscalation.selector);
        account.executeSessionAction(a, sig);
    }

    function test_sessionCannotChangeOwnerGuardiansOrSessionsDirectly() public {
        vm.startPrank(sessionKey);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setOwner(sessionKey);
        address[] memory g = new address[](1);
        g[0] = sessionKey;
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setGuardians(g, 1, 1 days);
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.revokeSession(sessionKey);
        vm.expectRevert(ConsumerAccount.NotGuardian.selector);
        account.proposeRecovery(sessionKey);
        vm.stopPrank();
    }

    function test_sessionCannotSelfCallThroughOwnerPath() public {
        // Session tries to grant itself a bigger cap via a self-call: still a raw call.
        ConsumerAccount.SessionConfig memory cfg;
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(account), 0, abi.encodeCall(ConsumerAccount.grantSession, (cfg))));
        bytes memory sig = _signOwner(account, intent, sessionPk);
        vm.expectRevert(ConsumerAccount.RawCallForbidden.selector);
        account.executeOwnerIntent(intent, sig);
    }

    function test_withdrawForbidden() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.VAULT_WITHDRAW, abi.encode(uint256(1)));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.WithdrawForbidden.selector);
        account.executeSessionAction(a, sig);
    }

    function test_actionNotAllowed() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_unknownActionNotAllowed() public {
        ConsumerAccount.SessionAction memory a = _action(keccak256("consumer.action.unknown"), hex"");
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_recipientNotAllowed() public {
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = Actions.PAYMENT;
        address[] memory recipients = new address[](1);
        recipients[0] = merchant;
        _grant(sessionKey, actions, recipients, 10e6, 25e6, uint64(block.timestamp + 1 days));

        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), stranger, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.RecipientNotAllowed.selector);
        account.executeSessionAction(a, sig);

        a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        account.executeSessionAction(a, _signAction(a, sessionPk));
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_unpriceableSpendFailsClosed() public {
        oracle.disable(address(usdc));
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PriceUnavailable.selector);
        account.executeSessionAction(a, sig);
    }

    function test_noOracleFailsClosed() public {
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setOracle, (IPriceOracle(address(0)))));
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PriceUnavailable.selector);
        account.executeSessionAction(a, sig);
    }

    function test_perCallCap() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 10e6 + 1));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeSessionAction(a, sig);
    }

    function test_dailyCapAndReset() public {
        for (uint256 i; i < 2; ++i) {
            ConsumerAccount.SessionAction memory ok = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 10e6));
            account.executeSessionAction(ok, _signAction(ok, sessionPk));
        }
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 5e6 + 1));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.DailyCapExceeded.selector);
        account.executeSessionAction(a, sig);

        // HBAR spend is priced too: 100 HBAR at the mock $0.05 = $5.00, exactly the remaining headroom.
        ConsumerAccount.SessionAction memory hbar = _action(Actions.PAYMENT, _pay(address(0), merchant, 100e8));
        account.executeSessionAction(hbar, _signAction(hbar, sessionPk));
        assertEq(merchant.balance, 100e8);

        vm.warp(block.timestamp + 1 days);
        _grantDefaultSession(); // session expired after 1 day; re-grant
        ConsumerAccount.SessionAction memory next = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 10e6));
        account.executeSessionAction(next, _signAction(next, sessionPk));
    }

    function test_sessionReplayFails() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        account.executeSessionAction(a, sig);
        vm.expectRevert(ConsumerAccount.IntentReplayed.selector);
        account.executeSessionAction(a, sig);
    }

    function test_sessionTamperedPayloadFails() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        a.actionData = _pay(address(usdc), stranger, 1e6);
        // Recovers to an unknown address.
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeSessionAction(a, sig);
    }

    function test_grantRejectsPrivilegedActions() public {
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = Actions.ADMIN_GRANT_SESSION;
        ConsumerAccount.SessionConfig memory cfg = ConsumerAccount.SessionConfig({
            key: sessionKey,
            expiresAt: uint64(block.timestamp + 1 days),
            perCallCapUsd6: 1,
            dailyCapUsd6: 1,
            allowedActions: actions,
            allowedRecipients: new address[](0)
        });
        ConsumerAccount.OwnerIntent memory intent =
            _ownerIntent(_call(address(account), 0, abi.encodeCall(ConsumerAccount.grantSession, (cfg))));
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert(); // CallFailed(PrivilegeEscalation)
        account.executeOwnerIntent(intent, sig);
    }

    function test_revokedSessionLosesAuthority() public {
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.revokeSession, (sessionKey)));
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeSessionAction(a, sig);
    }

    function test_ownerRotationRevokesSessions() public {
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setOwner, (vm.addr(0xCAFE))));
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeSessionAction(a, sig);
    }

    function test_ownerTypedActionSkipsCaps() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 500e6));
        account.executeSessionAction(a, _signAction(a, ownerPk));
        assertEq(usdc.balanceOf(merchant), 500e6);
    }

    function test_airdropActionCallsHtsAndChecksCode() public {
        ConsumerAccount.SessionAction memory a = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 7e6));
        account.executeSessionAction(a, _signAction(a, ownerPk));
        assertEq(hts.airdropCalls(), 1);
        assertEq(hts.lastSender(), address(account));
        assertEq(hts.lastReceiver(), merchant);
        assertEq(hts.lastAmount(), int64(7e6));

        hts.setResponseCode(178);
        ConsumerAccount.SessionAction memory b = _action(Actions.AIRDROP, _pay(address(usdc), merchant, 7e6));
        bytes memory sig = _signAction(b, ownerPk);
        vm.expectRevert(abi.encodeWithSelector(ConsumerAccount.HtsCallFailed.selector, int64(178)));
        account.executeSessionAction(b, sig);
    }

    function test_typedDataDigestMatchesEip712Spec() public view {
        ConsumerAccount.SessionAction memory a = ConsumerAccount.SessionAction({
            actionId: Actions.PAYMENT, actionData: _pay(address(usdc), merchant, 1), nonce: 42, validUntil: 1234
        });
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ConsumerAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("SessionAction(bytes32 actionId,bytes actionData,uint256 nonce,uint64 validUntil)"),
                a.actionId,
                keccak256(a.actionData),
                a.nonce,
                a.validUntil
            )
        );
        assertEq(account.hashSessionAction(a), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}

contract X402ExecutorTest is AccountFixture {
    function _auth(address asset, address to, uint256 amount, uint256 nonce, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        uint64 validUntil = uint64(block.timestamp + 180);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "TransferAuthorization(address from,address asset,address to,uint256 amount,uint256 nonce,uint64 validUntil)"
                ),
                address(account),
                asset,
                to,
                amount,
                nonce,
                validUntil
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", account.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(nonce, validUntil, abi.encodePacked(r, s, v));
    }

    function test_facilitatorSettlesOwnerAuthorization() public {
        bytes memory auth = _auth(address(usdc), merchant, 2e6, 900, ownerPk);
        vm.prank(makeAddr("facilitator"));
        account.executeTransfer(address(account), address(usdc), merchant, 2e6, auth);
        assertEq(usdc.balanceOf(merchant), 2e6);
    }

    function test_authorizationIsSingleUse() public {
        bytes memory auth = _auth(address(usdc), merchant, 2e6, 901, ownerPk);
        account.executeTransfer(address(account), address(usdc), merchant, 2e6, auth);
        vm.expectRevert(ConsumerAccount.IntentReplayed.selector);
        account.executeTransfer(address(account), address(usdc), merchant, 2e6, auth);
    }

    function test_cannotRedirectRecipientAssetOrAmount() public {
        bytes memory auth = _auth(address(usdc), merchant, 2e6, 902, ownerPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeTransfer(address(account), address(usdc), stranger, 2e6, auth);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeTransfer(address(account), address(usdc), merchant, 3e6, auth);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeTransfer(address(account), address(0), merchant, 2e6, auth);
        vm.expectRevert(ConsumerAccount.TransferFromMismatch.selector);
        account.executeTransfer(stranger, address(usdc), merchant, 2e6, auth);
        assertFalse(account.nonceUsed(902));
    }

    function test_sessionX402RespectsPolicy() public {
        _grantDefaultSession();
        bytes memory auth = _auth(address(usdc), merchant, 2e6, 903, sessionPk);
        account.executeTransfer(address(account), address(usdc), merchant, 2e6, auth);
        assertEq(account.getSession(sessionKey).spentTodayUsd6, 2e6);

        bytes memory big = _auth(address(usdc), merchant, 11e6, 904, sessionPk);
        vm.expectRevert(ConsumerAccount.PerCallCapExceeded.selector);
        account.executeTransfer(address(account), address(usdc), merchant, 11e6, big);
    }

    function test_sessionWithoutX402ActionDenied() public {
        bytes32[] memory actions = new bytes32[](1);
        actions[0] = Actions.PAYMENT;
        _grant(sessionKey, actions, new address[](0), 10e6, 25e6, uint64(block.timestamp + 1 days));
        bytes memory auth = _auth(address(usdc), merchant, 1e6, 905, sessionPk);
        vm.expectRevert(ConsumerAccount.ActionNotAllowed.selector);
        account.executeTransfer(address(account), address(usdc), merchant, 1e6, auth);
    }

    function test_selectorMatchesX402Spec() public pure {
        assertEq(ConsumerAccount.executeTransfer.selector, bytes4(0xea8f19fd));
    }
}

contract RecoveryTest is AccountFixture {
    address internal g1 = makeAddr("guardian1");
    address internal g2 = makeAddr("guardian2");
    address internal g3 = makeAddr("guardian3");
    address internal newOwner = makeAddr("newOwner");

    function setUp() public override {
        super.setUp();
        address[] memory gs = new address[](3);
        gs[0] = g1;
        gs[1] = g2;
        gs[2] = g3;
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.setGuardians, (gs, 2, 1 days)));
    }

    function test_belowThresholdCannotExecute() public {
        vm.prank(g1);
        account.proposeRecovery(newOwner);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(ConsumerAccount.RecoveryNotReady.selector);
        account.executeRecovery();
    }

    function test_thresholdThenTimelockThenExecute() public {
        _grantDefaultSession();
        vm.prank(g1);
        account.proposeRecovery(newOwner);
        vm.prank(g2);
        account.approveRecovery();

        vm.expectRevert(ConsumerAccount.RecoveryNotReady.selector);
        account.executeRecovery();

        vm.warp(block.timestamp + 1 days);
        vm.prank(stranger);
        account.executeRecovery();
        assertEq(account.owner(), newOwner);

        // Sessions granted by the previous owner are dead.
        ConsumerAccount.SessionAction memory a = _action(Actions.PAYMENT, _pay(address(usdc), merchant, 1e6));
        bytes memory sig = _signAction(a, sessionPk);
        vm.expectRevert(ConsumerAccount.SignatureInvalid.selector);
        account.executeSessionAction(a, sig);
    }

    function test_duplicateApprovalRejected() public {
        vm.prank(g1);
        account.proposeRecovery(newOwner);
        vm.prank(g1);
        vm.expectRevert(ConsumerAccount.RecoveryAlreadyApproved.selector);
        account.approveRecovery();
    }

    function test_ownerCancelsPendingRecovery() public {
        vm.prank(g1);
        account.proposeRecovery(newOwner);
        vm.prank(g2);
        account.approveRecovery();
        _ownerSelfCall(abi.encodeCall(ConsumerAccount.cancelRecovery, ()));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(ConsumerAccount.NoRecoveryPending.selector);
        account.executeRecovery();
        assertEq(account.owner(), ownerAddr);
    }

    function test_nonGuardianAndSessionCannotDriveRecovery() public {
        _grantDefaultSession();
        vm.prank(sessionKey);
        vm.expectRevert(ConsumerAccount.NotGuardian.selector);
        account.proposeRecovery(sessionKey);
        vm.prank(stranger);
        vm.expectRevert(ConsumerAccount.NotGuardian.selector);
        account.approveRecovery();
    }

    function test_guardianConfigValidation() public {
        address[] memory gs = new address[](1);
        gs[0] = g1;
        ConsumerAccount.OwnerIntent memory intent = _ownerIntent(
            _call(address(account), 0, abi.encodeCall(ConsumerAccount.setGuardians, (gs, 1, 1 minutes)))
        );
        bytes memory sig = _signOwner(account, intent, ownerPk);
        vm.expectRevert(); // timelock below MIN_RECOVERY_DELAY
        account.executeOwnerIntent(intent, sig);
    }
}

contract FactoryTest is AccountFixture {
    function test_deterministicAndIdempotent() public {
        address predicted = factory.getAddress(ownerAddr, bytes32(uint256(7)));
        vm.prank(relayer);
        ConsumerAccount a = factory.createAccount(ownerAddr, bytes32(uint256(7)));
        assertEq(address(a), predicted);
        assertEq(a.owner(), ownerAddr);
        assertEq(address(factory.createAccount(ownerAddr, bytes32(uint256(7)))), predicted);
    }

    function test_attackerCannotClaimOwnersAddress() public {
        address predicted = factory.getAddress(ownerAddr, bytes32(uint256(8)));
        vm.prank(stranger);
        ConsumerAccount hijack = factory.createAccount(stranger, bytes32(uint256(8)));
        assertTrue(address(hijack) != predicted);
        ConsumerAccount real = factory.createAccount(ownerAddr, bytes32(uint256(8)));
        assertEq(real.owner(), ownerAddr);
    }

    function test_factoryHoldsNoAuthority() public {
        vm.startPrank(address(factory));
        vm.expectRevert(ConsumerAccount.NotSelf.selector);
        account.setOwner(address(factory));
        vm.stopPrank();
    }
}
