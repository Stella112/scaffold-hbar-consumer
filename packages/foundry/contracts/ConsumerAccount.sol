// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { ITransferExecutor } from "./interfaces/ITransferExecutor.sol";
import { Actions } from "./Actions.sol";
import { ISaucerSwapV2Router } from "./interfaces/ISaucerSwapV2Router.sol";

/// @title ConsumerAccount
/// @notice Programmable account for a human controller and the agents it delegates to.
///         - The owner signs EIP-712 intents; anyone (normally a sponsor relayer) submits them and pays the fee.
///         - Owner intents may carry raw calls. Session keys may only execute registered typed actions under
///           on-chain policy (expiry, allowed actions, recipients, USD per-call and daily caps).
///         - Guardians can rotate the owner after a threshold of approvals and a timelock.
///         - Implements the x402 `transferExecutor` interface so a facilitator can settle signed payments.
/// @dev The submitter (msg.sender) never gains authority. All authority comes from signatures or self-calls.
contract ConsumerAccount is EIP712, ReentrancyGuard, ITransferExecutor {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    /// @dev Hedera Schedule Service (HIP-1215). Same SUCCESS response code as HTS.
    address internal constant HSS = address(0x16b);
    uint64 public constant MIN_SUBSCRIPTION_INTERVAL = 60;
    uint32 public constant MIN_SUBSCRIPTION_GAS = 100_000;
    uint32 public constant MAX_SUBSCRIPTION_GAS = 3_000_000;
    /// Shortest allowed guardian-recovery timelock.
    uint64 public constant MIN_RECOVERY_DELAY = 5 minutes;
    uint256 public constant MAX_GUARDIANS = 16;

    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 internal constant OWNER_INTENT_TYPEHASH = keccak256(
        "OwnerIntent(Call[] calls,uint256 nonce,uint64 validUntil)Call(address target,uint256 value,bytes data)"
    );
    bytes32 internal constant SESSION_ACTION_TYPEHASH =
        keccak256("SessionAction(bytes32 actionId,bytes actionData,uint256 nonce,uint64 validUntil)");
    bytes32 internal constant TRANSFER_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferAuthorization(address from,address asset,address to,uint256 amount,uint256 nonce,uint64 validUntil)"
    );

    // ---------------------------------------------------------------- types

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct OwnerIntent {
        Call[] calls;
        uint256 nonce;
        uint64 validUntil;
    }

    struct SessionAction {
        bytes32 actionId;
        bytes actionData;
        uint256 nonce;
        uint64 validUntil;
    }

    struct SessionConfig {
        address key;
        uint64 expiresAt;
        uint128 perCallCapUsd6;
        uint128 dailyCapUsd6;
        bytes32[] allowedActions;
        /// Empty = any recipient.
        address[] allowedRecipients;
    }

    struct Session {
        uint64 expiresAt;
        uint64 epoch;
        uint64 ownerEpoch;
        uint32 day;
        bool recipientsRestricted;
        uint128 perCallCapUsd6;
        uint128 dailyCapUsd6;
        uint128 spentTodayUsd6;
    }

    /// Swap `tokenIn` for exactly `amountOut` of `tokenOut` delivered straight to `to`.
    /// `path` is a SaucerSwap V2 exact-output path: tokenOut, fee, ..., fee, tokenIn.
    struct SwapToPay {
        address router;
        address tokenIn;
        uint256 amountInMaximum;
        address tokenOut;
        uint256 amountOut;
        address to;
        uint256 deadline;
        bytes path;
    }

    struct Recovery {
        address newOwner;
        uint64 round;
        uint64 executableAt;
        uint32 approvals;
    }

    /// @notice Recurring payment executed by the Hedera Schedule Service; created and cancelled by the owner only.
    struct Subscription {
        address asset; // address(0) = HBAR (tinybars)
        address to;
        uint128 amount;
        uint64 interval; // seconds between payments
        uint64 nextAt; // unix seconds of the next due payment
        uint32 remaining; // payments left; 0 = inactive
        uint32 gasLimit; // gas for each scheduled execution
        address schedule; // current HSS schedule (0 if none)
    }

    // ---------------------------------------------------------------- errors (policy reason codes)

    error SessionExpired();
    error RawCallForbidden();
    error PrivilegeEscalation();
    error WithdrawForbidden();
    error ActionNotAllowed();
    error TargetNotAllowed();
    error RecipientNotAllowed();
    error PriceUnavailable();
    error PerCallCapExceeded();
    error DailyCapExceeded();
    error IntentExpired();
    error IntentReplayed();
    error SignatureInvalid();

    error NotSelf();
    error NotGuardian();
    error InvalidConfig();
    error CallFailed(uint256 index, bytes reason);
    error HtsCallMustBeTyped();
    error HtsCallFailed(int64 responseCode);
    error AmountOutOfRange();
    error TransferFromMismatch();
    error NativeTransferFailed();
    error RecoveryPending();
    error NoRecoveryPending();
    error RecoveryAlreadyApproved();
    error RecoveryNotReady();
    error SwapPathMismatch();
    error SwapUnderdelivered(uint256 delivered, uint256 requested);
    error SwapOverspent(uint256 amountIn, uint256 amountInMaximum);
    error SubscriptionInactive();
    error SubscriptionNotDue();
    error ScheduleFailed(int64 responseCode);

    // ---------------------------------------------------------------- events

    event OwnerIntentExecuted(uint256 indexed nonce, uint256 callCount);
    event ActionExecuted(
        bytes32 indexed actionId, address indexed signer, address asset, address to, uint256 amount, uint256 usd6
    );
    event X402TransferExecuted(address indexed signer, address asset, address to, uint256 amount, uint256 nonce);
    event SessionGranted(address indexed key, uint64 expiresAt, uint128 perCallCapUsd6, uint128 dailyCapUsd6);
    event SessionRevoked(address indexed key);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event GuardiansUpdated(address[] guardians, uint8 threshold, uint64 delay);
    event RecoveryProposed(uint64 indexed round, address indexed newOwner, address indexed guardian);
    event RecoveryApproved(uint64 indexed round, address indexed guardian, uint32 approvals);
    event RecoveryReady(uint64 indexed round, uint64 executableAt);
    event RecoveryCancelled(uint64 indexed round);
    event RecoveryExecuted(uint64 indexed round, address indexed newOwner);
    event OracleUpdated(address oracle);
    event TokenAssociated(address indexed token);
    event SwapRouterSet(address indexed router, bool allowed);
    event SubscriptionCreated(
        uint256 indexed id, address asset, address to, uint256 amount, uint64 interval, uint64 firstAt, uint32 count
    );
    event SubscriptionScheduled(uint256 indexed id, address schedule, uint64 at);
    event SubscriptionScheduleFailed(uint256 indexed id, int64 responseCode);
    event SubscriptionPaid(uint256 indexed id, uint32 remaining, uint64 nextAt);
    event SubscriptionCancelled(uint256 indexed id, bool scheduleDeleted);
    event SwapToPayExecuted(
        address indexed signer, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, address to
    );

    // ---------------------------------------------------------------- storage

    address public owner;
    /// Incremented whenever the owner changes; sessions granted under an older owner epoch are dead.
    uint64 public ownerEpoch;
    uint64 internal _sessionEpochCounter;
    IPriceOracle public oracle;

    mapping(uint256 => bool) public nonceUsed;
    mapping(address => Session) internal _sessions;
    /// keccak256(key, epoch, actionId) => allowed
    mapping(bytes32 => bool) internal _sessionActionAllowed;
    /// keccak256(key, epoch, recipient) => allowed
    mapping(bytes32 => bool) internal _sessionRecipientAllowed;

    address[] internal _guardians;
    mapping(address => bool) public isGuardian;
    uint8 public guardianThreshold;
    uint64 public recoveryDelay;
    Recovery public recovery;
    /// keccak256(round, guardian) => approved
    mapping(bytes32 => bool) internal _recoveryApproved;

    /// Routers the owner trusts for swap-to-pay. Sessions cannot change this list.
    mapping(address => bool) public swapRouterAllowed;

    mapping(uint256 => Subscription) public subscriptions;
    uint256 public subscriptionCount;

    // ---------------------------------------------------------------- construction

    constructor(address owner_, IPriceOracle oracle_) EIP712("ConsumerAccount", "1") {
        if (owner_ == address(0)) revert InvalidConfig();
        owner = owner_;
        oracle = oracle_;
        emit OwnerChanged(address(0), owner_);
    }

    receive() external payable { }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    // ---------------------------------------------------------------- owner intents (raw calls)

    /// @notice Executes owner-signed calls. Submitter identity is irrelevant.
    function executeOwnerIntent(OwnerIntent calldata intent, bytes calldata signature) external nonReentrant {
        address signer = ECDSA.recover(_hashTypedDataV4(_hashOwnerIntent(intent)), signature);
        if (signer != owner) {
            // A session key never gets raw-call authority, even for an otherwise valid signature.
            Session storage s = _sessions[signer];
            if (_sessionExists(s)) {
                if (s.expiresAt <= block.timestamp) revert SessionExpired();
                revert RawCallForbidden();
            }
            revert SignatureInvalid();
        }
        _useIntent(intent.nonce, intent.validUntil);

        uint256 n = intent.calls.length;
        for (uint256 i; i < n; ++i) {
            Call calldata c = intent.calls[i];
            // HTS returns response codes instead of reverting; force the typed helpers that check them.
            if (c.target == HTS) revert HtsCallMustBeTyped();
            (bool ok, bytes memory ret) = c.target.call{ value: c.value }(c.data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit OwnerIntentExecuted(intent.nonce, n);
    }

    // ---------------------------------------------------------------- typed actions (owner or session)

    /// @notice Executes a registered typed action signed by the owner (no caps) or an active session (policy).
    function executeSessionAction(SessionAction calldata action, bytes calldata signature) external nonReentrant {
        address signer = ECDSA.recover(_hashTypedDataV4(_hashSessionAction(action)), signature);
        bool isOwner = signer == owner;
        if (!isOwner) _requireLiveSession(signer);
        _useIntent(action.nonce, action.validUntil);

        bytes32 id = action.actionId;
        if (!isOwner) {
            if (Actions.isPrivileged(id)) revert PrivilegeEscalation();
            if (Actions.isWithdrawal(id)) revert WithdrawForbidden();
            if (!_sessionActionAllowed[_actionKey(signer, _sessions[signer].epoch, id)]) revert ActionNotAllowed();
        }

        if (id == Actions.SWAP_TO_PAY) {
            SwapToPay memory p = abi.decode(action.actionData, (SwapToPay));
            if (!swapRouterAllowed[p.router]) revert TargetNotAllowed();
            // Worst case the account spends amountInMaximum of tokenIn; price and cap that.
            uint256 swapUsd6 = isOwner ? 0 : _chargeSession(signer, p.tokenIn, p.to, p.amountInMaximum);
            uint256 amountIn = _swapToPay(p);
            emit SwapToPayExecuted(signer, p.tokenIn, amountIn, p.tokenOut, p.amountOut, p.to);
            emit ActionExecuted(id, signer, p.tokenOut, p.to, p.amountOut, swapUsd6);
            return;
        }

        (address asset, address to, uint256 amount) = _decodeTransferAction(id, action.actionData);
        uint256 usd6 = isOwner ? 0 : _chargeSession(signer, asset, to, amount);

        if (id == Actions.PAYMENT) {
            _transferOut(asset, to, amount);
        } else {
            _airdrop(asset, to, amount);
        }
        emit ActionExecuted(id, signer, asset, to, amount, usd6);
    }

    // ---------------------------------------------------------------- x402 transferExecutor

    /// @inheritdoc ITransferExecutor
    /// @dev authorization = abi.encode(uint256 nonce, uint64 validUntil, bytes signature) over
    ///      TransferAuthorization(from, asset, to, amount, nonce, validUntil). Binding all six fields means a
    ///      facilitator cannot redirect the recipient, asset or amount. The nonce is consumed only on success.
    function executeTransfer(address from, address asset, address to, uint256 amount, bytes calldata authorization)
        external
        nonReentrant
    {
        if (from != address(this)) revert TransferFromMismatch();
        (uint256 nonce, uint64 validUntil, bytes memory signature) = abi.decode(authorization, (uint256, uint64, bytes));
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_AUTHORIZATION_TYPEHASH, from, asset, to, amount, nonce, validUntil));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);

        bool isOwner = signer == owner;
        if (!isOwner) {
            _requireLiveSession(signer);
            if (!_sessionActionAllowed[_actionKey(signer, _sessions[signer].epoch, Actions.X402_PAYMENT)]) {
                revert ActionNotAllowed();
            }
        }
        _useIntent(nonce, validUntil);
        if (!isOwner) _chargeSession(signer, asset, to, amount);

        _transferOut(asset, to, amount);
        emit X402TransferExecuted(signer, asset, to, amount, nonce);
    }

    // ---------------------------------------------------------------- self-only administration

    function setOwner(address newOwner) external onlySelf {
        _setOwner(newOwner);
    }

    function grantSession(SessionConfig calldata cfg) external onlySelf {
        if (
            cfg.key == address(0) || cfg.key == owner || cfg.key == address(this) || cfg.expiresAt <= block.timestamp
                || cfg.allowedActions.length == 0 || cfg.perCallCapUsd6 > cfg.dailyCapUsd6
        ) revert InvalidConfig();

        uint64 epoch = ++_sessionEpochCounter;
        _sessions[cfg.key] = Session({
            expiresAt: cfg.expiresAt,
            epoch: epoch,
            ownerEpoch: ownerEpoch,
            day: uint32(block.timestamp / 1 days),
            recipientsRestricted: cfg.allowedRecipients.length != 0,
            perCallCapUsd6: cfg.perCallCapUsd6,
            dailyCapUsd6: cfg.dailyCapUsd6,
            spentTodayUsd6: 0
        });
        for (uint256 i; i < cfg.allowedActions.length; ++i) {
            bytes32 id = cfg.allowedActions[i];
            // Privileged or withdrawal capabilities can never be delegated to a session.
            if (Actions.isPrivileged(id) || Actions.isWithdrawal(id)) revert PrivilegeEscalation();
            _sessionActionAllowed[_actionKey(cfg.key, epoch, id)] = true;
        }
        for (uint256 i; i < cfg.allowedRecipients.length; ++i) {
            _sessionRecipientAllowed[_recipientKey(cfg.key, epoch, cfg.allowedRecipients[i])] = true;
        }
        emit SessionGranted(cfg.key, cfg.expiresAt, cfg.perCallCapUsd6, cfg.dailyCapUsd6);
    }

    function revokeSession(address key) external onlySelf {
        delete _sessions[key];
        emit SessionRevoked(key);
    }

    function setSwapRouter(address router, bool allowed) external onlySelf {
        if (router == address(0) || router == HTS || router == address(this)) revert InvalidConfig();
        swapRouterAllowed[router] = allowed;
        emit SwapRouterSet(router, allowed);
    }

    function setOracle(IPriceOracle oracle_) external onlySelf {
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    /// @notice Associates this account with an HTS token, checking the response code.
    function associateToken(address token) external onlySelf {
        int64 rc = IHederaTokenService(HTS).associateToken(address(this), token);
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
        emit TokenAssociated(token);
    }

    function setGuardians(address[] calldata guardians_, uint8 threshold, uint64 delay) external onlySelf {
        uint256 n = guardians_.length;
        if (n > MAX_GUARDIANS || threshold > n || (n != 0 && threshold == 0) || delay < MIN_RECOVERY_DELAY) {
            revert InvalidConfig();
        }
        _cancelRecovery();
        for (uint256 i; i < _guardians.length; ++i) {
            isGuardian[_guardians[i]] = false;
        }
        delete _guardians;
        for (uint256 i; i < n; ++i) {
            address g = guardians_[i];
            if (g == address(0) || g == owner || isGuardian[g]) revert InvalidConfig();
            isGuardian[g] = true;
            _guardians.push(g);
        }
        guardianThreshold = threshold;
        recoveryDelay = delay;
        emit GuardiansUpdated(guardians_, threshold, delay);
    }

    /// @notice Owner cancels a pending recovery (via a signed self-call).
    function cancelRecovery() external onlySelf {
        if (recovery.newOwner == address(0)) revert NoRecoveryPending();
        _cancelRecovery();
    }

    // ---------------------------------------------------------------- recurring payments (HSS)

    /// @notice Creates a recurring payment and schedules its first execution with the Hedera Schedule Service.
    ///         The account pays the scheduled transactions' fees, so it must hold HBAR.
    function createSubscription(
        address asset,
        address to,
        uint128 amount,
        uint64 interval,
        uint64 firstAt,
        uint32 count,
        uint32 gasLimit
    ) external onlySelf returns (uint256 id) {
        if (
            to == address(0) || amount == 0 || count == 0 || interval < MIN_SUBSCRIPTION_INTERVAL
                || firstAt <= block.timestamp || gasLimit < MIN_SUBSCRIPTION_GAS || gasLimit > MAX_SUBSCRIPTION_GAS
        ) revert InvalidConfig();
        id = ++subscriptionCount;
        subscriptions[id] = Subscription({
            asset: asset,
            to: to,
            amount: amount,
            interval: interval,
            nextAt: firstAt,
            remaining: count,
            gasLimit: gasLimit,
            schedule: address(0)
        });
        emit SubscriptionCreated(id, asset, to, amount, interval, firstAt, count);
        int64 rc = _schedule(id, firstAt, gasLimit);
        if (rc != HTS_SUCCESS) revert ScheduleFailed(rc);
    }

    /// @notice Stops a recurring payment and deletes its pending schedule (best effort).
    function cancelSubscription(uint256 id) external onlySelf {
        Subscription storage s = subscriptions[id];
        if (s.remaining == 0) revert SubscriptionInactive();
        s.remaining = 0;
        address sched = s.schedule;
        s.schedule = address(0);
        bool deleted;
        if (sched != address(0)) {
            // A schedule that already executed or expired cannot be deleted; remaining == 0 makes it inert anyway.
            (bool ok, bytes memory ret) = HSS.call(abi.encodeCall(IHederaScheduleService.deleteSchedule, (sched)));
            deleted = ok && ret.length >= 32 && abi.decode(ret, (int64)) == HTS_SUCCESS;
        }
        emit SubscriptionCancelled(id, deleted);
    }

    /// @notice Pays one due instalment and schedules the next. Permissionless but inert: it can only pay the
    ///         owner-configured recipient and amount, only once due, and only while payments remain.
    function executeSubscription(uint256 id) external nonReentrant {
        Subscription storage s = subscriptions[id];
        if (s.remaining == 0) revert SubscriptionInactive();
        if (block.timestamp < s.nextAt) revert SubscriptionNotDue();
        uint32 remaining = s.remaining - 1;
        uint64 nextAt = s.nextAt + s.interval;
        s.remaining = remaining;
        s.nextAt = nextAt;
        s.schedule = address(0);
        _transferOut(s.asset, s.to, s.amount);
        emit SubscriptionPaid(id, remaining, nextAt);
        if (remaining != 0) {
            // A due date already in the past cannot be scheduled; the next call to this function catches up.
            uint64 at = nextAt > block.timestamp ? nextAt : uint64(block.timestamp) + 1;
            int64 rc = _schedule(id, at, s.gasLimit);
            // Never block a payment on rescheduling; anyone can execute the next instalment once due.
            if (rc != HTS_SUCCESS) emit SubscriptionScheduleFailed(id, rc);
        }
    }

    function _schedule(uint256 id, uint64 at, uint32 gasLimit) internal returns (int64 rc) {
        (bool ok, bytes memory ret) = HSS.call(
            abi.encodeCall(
                IHederaScheduleService.scheduleCall,
                (address(this), at, gasLimit, 0, abi.encodeCall(this.executeSubscription, (id)))
            )
        );
        if (!ok || ret.length < 64) return -1;
        address sched;
        (rc, sched) = abi.decode(ret, (int64, address));
        if (rc == HTS_SUCCESS) {
            subscriptions[id].schedule = sched;
            emit SubscriptionScheduled(id, sched, at);
        }
    }

    // ---------------------------------------------------------------- guardian recovery

    function proposeRecovery(address newOwner) external {
        if (!isGuardian[msg.sender]) revert NotGuardian();
        if (recovery.newOwner != address(0)) revert RecoveryPending();
        if (newOwner == address(0) || newOwner == address(this)) revert InvalidConfig();
        uint64 round = recovery.round + 1;
        recovery = Recovery({ newOwner: newOwner, round: round, executableAt: 0, approvals: 0 });
        emit RecoveryProposed(round, newOwner, msg.sender);
        _approveRecovery(msg.sender);
    }

    function approveRecovery() external {
        if (!isGuardian[msg.sender]) revert NotGuardian();
        if (recovery.newOwner == address(0)) revert NoRecoveryPending();
        _approveRecovery(msg.sender);
    }

    /// @notice Anyone may finalize once the threshold was reached and the timelock elapsed.
    function executeRecovery() external {
        Recovery memory r = recovery;
        if (r.newOwner == address(0)) revert NoRecoveryPending();
        if (r.executableAt == 0 || block.timestamp < r.executableAt) revert RecoveryNotReady();
        recovery = Recovery({ newOwner: address(0), round: r.round, executableAt: 0, approvals: 0 });
        _setOwner(r.newOwner);
        emit RecoveryExecuted(r.round, r.newOwner);
    }

    // ---------------------------------------------------------------- views

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function guardians() external view returns (address[] memory) {
        return _guardians;
    }

    function getSession(address key) external view returns (Session memory) {
        return _sessions[key];
    }

    function isSessionActionAllowed(address key, bytes32 actionId) external view returns (bool) {
        return _sessionActionAllowed[_actionKey(key, _sessions[key].epoch, actionId)];
    }

    function hashOwnerIntent(OwnerIntent calldata intent) external view returns (bytes32) {
        return _hashTypedDataV4(_hashOwnerIntent(intent));
    }

    function hashSessionAction(SessionAction calldata action) external view returns (bytes32) {
        return _hashTypedDataV4(_hashSessionAction(action));
    }

    // ---------------------------------------------------------------- internals

    function _requireLiveSession(address key) internal view {
        Session storage s = _sessions[key];
        if (!_sessionExists(s)) revert SignatureInvalid();
        if (s.expiresAt <= block.timestamp) revert SessionExpired();
    }

    function _sessionExists(Session storage s) internal view returns (bool) {
        return s.epoch != 0 && s.ownerEpoch == ownerEpoch;
    }

    function _useIntent(uint256 nonce, uint64 validUntil) internal {
        if (validUntil < block.timestamp) revert IntentExpired();
        if (nonceUsed[nonce]) revert IntentReplayed();
        nonceUsed[nonce] = true;
    }

    /// @dev Policy steps 8–11: recipient, price, per-call cap, daily cap. Fails closed.
    function _chargeSession(address key, address asset, address to, uint256 amount) internal returns (uint256 usd6) {
        Session storage s = _sessions[key];
        if (s.recipientsRestricted && !_sessionRecipientAllowed[_recipientKey(key, s.epoch, to)]) {
            revert RecipientNotAllowed();
        }
        IPriceOracle o = oracle;
        if (address(o) == address(0)) revert PriceUnavailable();
        bool ok;
        (ok, usd6) = o.quoteUsd6(asset, amount);
        if (!ok) revert PriceUnavailable();
        if (usd6 > s.perCallCapUsd6) revert PerCallCapExceeded();

        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = s.day == today ? s.spentTodayUsd6 : 0;
        if (spent + usd6 > s.dailyCapUsd6) revert DailyCapExceeded();
        s.day = today;
        s.spentTodayUsd6 = uint128(spent + usd6);
    }

    function _decodeTransferAction(bytes32 id, bytes calldata data)
        internal
        pure
        returns (address asset, address to, uint256 amount)
    {
        if (id != Actions.PAYMENT && id != Actions.AIRDROP) revert ActionNotAllowed();
        (asset, to, amount) = abi.decode(data, (address, address, uint256));
        if (to == address(0) || amount == 0) revert InvalidConfig();
        if (id == Actions.AIRDROP && asset == address(0)) revert InvalidConfig();
    }

    function _transferOut(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            // Inside the Hedera EVM native value is denominated in tinybars.
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /// @dev HIP-904. Delivers immediately to associated receivers or ones with free auto-association slots,
    ///      otherwise creates a pending airdrop. Fees and pending-airdrop rent are charged to the submitter.
    function _airdrop(address token, address to, uint256 amount) internal {
        if (amount > uint256(uint64(type(int64).max))) revert AmountOutOfRange();
        int64 amt = int64(uint64(amount));
        IHederaTokenService.AccountAmount[] memory transfers = new IHederaTokenService.AccountAmount[](2);
        transfers[0] = IHederaTokenService.AccountAmount({ accountID: address(this), amount: -amt, isApproval: false });
        transfers[1] = IHederaTokenService.AccountAmount({ accountID: to, amount: amt, isApproval: false });
        IHederaTokenService.TokenTransferList[] memory lists = new IHederaTokenService.TokenTransferList[](1);
        lists[0] = IHederaTokenService.TokenTransferList({
            token: token, transfers: transfers, nftTransfers: new IHederaTokenService.NftTransfer[](0)
        });
        int64 rc = IHederaTokenService(HTS).airdropTokens(lists);
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
    }

    /// @dev Approves exactly amountInMaximum, swaps, revokes the approval and verifies the recipient's balance grew
    ///      by at least amountOut. Unspent input never leaves the account (exact-output pulls only what it needs).
    function _swapToPay(SwapToPay memory p) internal returns (uint256 amountIn) {
        if (p.tokenIn == address(0) || p.tokenOut == address(0) || p.to == address(0) || p.amountOut == 0) {
            revert InvalidConfig();
        }
        if (block.timestamp > p.deadline) revert IntentExpired();
        if (_firstAddress(p.path) != p.tokenOut || _lastAddress(p.path) != p.tokenIn) revert SwapPathMismatch();

        IERC20 out = IERC20(p.tokenOut);
        uint256 before = out.balanceOf(p.to);
        IERC20(p.tokenIn).forceApprove(p.router, p.amountInMaximum);
        ISaucerSwapV2Router.ExactOutputParams memory params = ISaucerSwapV2Router.ExactOutputParams({
            path: p.path,
            recipient: p.to,
            deadline: p.deadline,
            amountOut: p.amountOut,
            amountInMaximum: p.amountInMaximum
        });
        amountIn = ISaucerSwapV2Router(p.router).exactOutput(params);
        IERC20(p.tokenIn).forceApprove(p.router, 0);
        if (amountIn > p.amountInMaximum) revert SwapOverspent(amountIn, p.amountInMaximum);
        uint256 delivered = out.balanceOf(p.to) - before;
        if (delivered < p.amountOut) revert SwapUnderdelivered(delivered, p.amountOut);
    }

    function _firstAddress(bytes memory path) internal pure returns (address a) {
        if (path.length < 43) revert SwapPathMismatch();
        assembly {
            a := shr(96, mload(add(path, 32)))
        }
    }

    function _lastAddress(bytes memory path) internal pure returns (address a) {
        uint256 len = path.length;
        if (len < 43 || (len - 20) % 23 != 0) revert SwapPathMismatch();
        assembly {
            a := shr(96, mload(add(add(path, 32), sub(len, 20))))
        }
    }

    function _approveRecovery(address guardian) internal {
        Recovery storage r = recovery;
        bytes32 k = keccak256(abi.encode(r.round, guardian));
        if (_recoveryApproved[k]) revert RecoveryAlreadyApproved();
        _recoveryApproved[k] = true;
        uint32 approvals = ++r.approvals;
        emit RecoveryApproved(r.round, guardian, approvals);
        if (approvals == guardianThreshold) {
            uint64 at = uint64(block.timestamp) + recoveryDelay;
            r.executableAt = at;
            emit RecoveryReady(r.round, at);
        }
    }

    function _cancelRecovery() internal {
        if (recovery.newOwner == address(0)) return;
        uint64 round = recovery.round;
        recovery = Recovery({ newOwner: address(0), round: round, executableAt: 0, approvals: 0 });
        emit RecoveryCancelled(round);
    }

    function _setOwner(address newOwner) internal {
        if (newOwner == address(0) || newOwner == address(this) || isGuardian[newOwner]) revert InvalidConfig();
        address prev = owner;
        owner = newOwner;
        // Revokes every session granted under the previous owner.
        ++ownerEpoch;
        emit OwnerChanged(prev, newOwner);
    }

    function _hashOwnerIntent(OwnerIntent calldata intent) internal pure returns (bytes32) {
        uint256 n = intent.calls.length;
        bytes32[] memory callHashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            Call calldata c = intent.calls[i];
            callHashes[i] = keccak256(abi.encode(CALL_TYPEHASH, c.target, c.value, keccak256(c.data)));
        }
        return keccak256(
            abi.encode(OWNER_INTENT_TYPEHASH, keccak256(abi.encodePacked(callHashes)), intent.nonce, intent.validUntil)
        );
    }

    function _hashSessionAction(SessionAction calldata a) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(SESSION_ACTION_TYPEHASH, a.actionId, keccak256(a.actionData), a.nonce, a.validUntil));
    }

    function _actionKey(address key, uint64 epoch, bytes32 actionId) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, epoch, actionId));
    }

    function _recipientKey(address key, uint64 epoch, address recipient) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, epoch, bytes32("recipient"), recipient));
    }
}
