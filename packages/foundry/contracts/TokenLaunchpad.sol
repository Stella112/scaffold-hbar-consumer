// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";

/// @title TokenLaunchpad
/// @notice All-or-nothing launches of fixed-supply HTS tokens. The launchpad creates the token with no admin, supply,
///         freeze or wipe keys (nobody can mint more or freeze holders) and holds it as treasury. Buyers pay HBAR at a
///         fixed price. If the raise reaches its target the launch graduates exactly once: the creator receives the
///         HBAR and everyone claims their tokens, delivered by HIP-904 airdrop (no prior association needed). If the
///         deadline passes first, buyers are refunded.
/// @dev Inside the Hedera EVM msg.value and balances are tinybars. HTS amounts are int64 and every response code is
///      checked. Session keys of a ConsumerAccount have no typed action for this contract, so agents cannot buy.
contract TokenLaunchpad is ReentrancyGuard {
    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days
    uint64 public constant MIN_DURATION = 60;
    uint64 public constant MAX_DURATION = 30 days;

    struct Launch {
        address creator;
        address token;
        uint8 decimals;
        bool graduated;
        uint64 deadline;
        uint64 supply; // smallest units
        uint64 forSale; // smallest units offered to buyers
        uint64 sold; // smallest units sold
        uint128 priceTinybars; // per whole token (10^decimals units)
        uint128 target; // tinybars to raise for graduation
        uint128 raised; // tinybars received
        bool creatorClaimed;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint8 decimals;
        uint64 supply;
        uint64 forSale;
        uint128 priceTinybars;
        uint128 target;
        uint64 duration;
    }

    Launch[] internal _launches;
    /// @notice launchId => buyer => token units bought / tinybars paid (zeroed on claim or refund)
    mapping(uint256 => mapping(address => uint64)) public bought;
    mapping(uint256 => mapping(address => uint128)) public paid;

    event Launched(
        uint256 indexed id,
        address indexed creator,
        address token,
        uint64 supply,
        uint64 forSale,
        uint128 price,
        uint128 target
    );
    event Bought(uint256 indexed id, address indexed buyer, uint64 amount, uint128 cost);
    event Graduated(uint256 indexed id, uint128 raised);
    event Claimed(uint256 indexed id, address indexed account, uint64 amount);
    event Refunded(uint256 indexed id, address indexed buyer, uint128 amount);

    error InvalidLaunch();
    error UnknownLaunch();
    error SaleClosed();
    error SoldOut();
    error WrongPayment(uint256 expected);
    error TargetNotReached();
    error AlreadyGraduated();
    error NotGraduated();
    error RefundsClosed();
    error NothingToClaim();
    error HtsCallFailed(int64 responseCode);
    error NativeTransferFailed();

    /// @notice Creates the token and opens its sale. Send enough HBAR to cover the HTS token-creation fee; any
    ///         unspent part is returned to the creator.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (uint256 id, address token) {
        if (
            bytes(p.name).length == 0 || bytes(p.symbol).length == 0 || p.decimals > 18 || p.supply == 0
                || p.supply > uint64(type(int64).max) || p.forSale == 0 || p.forSale > p.supply || p.priceTinybars == 0
                || p.target == 0 || p.duration < MIN_DURATION || p.duration > MAX_DURATION
                || _cost(p.forSale, p.priceTinybars, p.decimals) < p.target
                || _cost(p.forSale, p.priceTinybars, p.decimals) > type(uint128).max
        ) revert InvalidLaunch();

        IHederaTokenService.HederaToken memory t;
        t.name = p.name;
        t.symbol = p.symbol;
        t.treasury = address(this);
        t.memo = "TokenLaunchpad";
        t.tokenSupplyType = true; // FINITE
        t.maxSupply = int64(p.supply);
        t.tokenKeys = new IHederaTokenService.TokenKey[](0); // immutable: no admin/supply/freeze/wipe/pause keys
        t.expiry = IHederaTokenService.Expiry({
            second: 0, autoRenewAccount: address(this), autoRenewPeriod: AUTO_RENEW_PERIOD
        });

        uint256 balanceBefore = address(this).balance;
        int64 rc;
        (rc, token) = IHederaTokenService(HTS).createFungibleToken{ value: msg.value }(
            t, int64(p.supply), int32(uint32(p.decimals))
        );
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
        uint256 feeSpent = balanceBefore - address(this).balance;
        if (msg.value > feeSpent) _sendHbar(msg.sender, msg.value - feeSpent);

        id = _launches.length;
        _launches.push(
            Launch({
                creator: msg.sender,
                token: token,
                decimals: p.decimals,
                graduated: false,
                deadline: uint64(block.timestamp) + p.duration,
                supply: p.supply,
                forSale: p.forSale,
                sold: 0,
                priceTinybars: p.priceTinybars,
                target: p.target,
                raised: 0,
                creatorClaimed: false
            })
        );
        emit Launched(id, msg.sender, token, p.supply, p.forSale, p.priceTinybars, p.target);
    }

    /// @notice Buys `amount` smallest units; msg.value must equal `quote(id, amount)` exactly.
    function buy(uint256 id, uint64 amount) external payable nonReentrant {
        Launch storage l = _launch(id);
        if (l.graduated || block.timestamp >= l.deadline) revert SaleClosed();
        if (amount == 0 || amount > l.forSale - l.sold) revert SoldOut();
        uint128 cost = uint128(_cost(amount, l.priceTinybars, l.decimals));
        if (cost == 0 || msg.value != cost) revert WrongPayment(cost);
        l.sold += amount;
        l.raised += cost;
        bought[id][msg.sender] += amount;
        paid[id][msg.sender] += cost;
        emit Bought(id, msg.sender, amount, cost);
    }

    /// @notice Permissionless. Releases the raise to the creator exactly once; afterwards tokens become claimable.
    function graduate(uint256 id) external nonReentrant {
        Launch storage l = _launch(id);
        if (l.graduated) revert AlreadyGraduated();
        if (l.raised < l.target) revert TargetNotReached();
        l.graduated = true; // effects before the HBAR transfer: a second call can never pay again
        emit Graduated(id, l.raised);
        _sendHbar(l.creator, l.raised);
    }

    /// @notice After graduation: buyers receive what they bought; the creator receives the unsold and retained supply.
    ///         Delivered by HIP-904 airdrop, so unassociated accounts get a claimable pending airdrop.
    function claim(uint256 id) external nonReentrant {
        Launch storage l = _launch(id);
        if (!l.graduated) revert NotGraduated();
        uint64 amount = bought[id][msg.sender];
        bought[id][msg.sender] = 0;
        if (msg.sender == l.creator && !l.creatorClaimed) {
            l.creatorClaimed = true;
            amount += l.supply - l.sold;
        }
        if (amount == 0) revert NothingToClaim();
        _airdrop(l.token, msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice After a missed deadline: buyers get their HBAR back once. The creator may then reclaim the supply.
    function refund(uint256 id) external nonReentrant {
        Launch storage l = _launch(id);
        if (l.graduated || block.timestamp < l.deadline || l.raised >= l.target) revert RefundsClosed();
        uint128 amount = paid[id][msg.sender];
        if (amount == 0) revert NothingToClaim();
        paid[id][msg.sender] = 0;
        bought[id][msg.sender] = 0;
        emit Refunded(id, msg.sender, amount);
        _sendHbar(msg.sender, amount);
    }

    /// @dev Only the HTS system contract may send HBAR here (unspent token-creation fee).
    receive() external payable {
        if (msg.sender != HTS) revert NativeTransferFailed();
    }

    // ------------------------------------------------------------------ views

    function quote(uint256 id, uint64 amount) external view returns (uint256 tinybars) {
        Launch storage l = _launch(id);
        return _cost(amount, l.priceTinybars, l.decimals);
    }

    function launches(uint256 id) external view returns (Launch memory) {
        return _launch(id);
    }

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    // ------------------------------------------------------------------ internals

    function _launch(uint256 id) internal view returns (Launch storage) {
        if (id >= _launches.length) revert UnknownLaunch();
        return _launches[id];
    }

    /// @dev Rounds up so buyers never underpay for fractional units.
    function _cost(uint256 amount, uint256 priceTinybars, uint8 decimals) internal pure returns (uint256) {
        uint256 unit = 10 ** uint256(decimals);
        return (amount * priceTinybars + unit - 1) / unit;
    }

    function _airdrop(address token, address to, uint64 amount) internal {
        IHederaTokenService.AccountAmount[] memory transfers = new IHederaTokenService.AccountAmount[](2);
        transfers[0] =
            IHederaTokenService.AccountAmount({ accountID: address(this), amount: -int64(amount), isApproval: false });
        transfers[1] = IHederaTokenService.AccountAmount({ accountID: to, amount: int64(amount), isApproval: false });
        IHederaTokenService.TokenTransferList[] memory lists = new IHederaTokenService.TokenTransferList[](1);
        lists[0] = IHederaTokenService.TokenTransferList({
            token: token, transfers: transfers, nftTransfers: new IHederaTokenService.NftTransfer[](0)
        });
        int64 rc = IHederaTokenService(HTS).airdropTokens(lists);
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
    }

    function _sendHbar(address to, uint256 amount) internal {
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }
}
