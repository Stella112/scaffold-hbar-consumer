// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IExchangeRate, ISaucerSwapV1Factory, ISaucerSwapV1Router } from "./interfaces/ISaucerSwapV1.sol";

/// @title TokenLaunchpad
/// @notice Bonding-curve launches of fixed-supply HTS tokens that graduate into SaucerSwap liquidity.
///         The launchpad creates the token with no admin, supply, freeze, wipe or pause keys and holds it as
///         treasury. Buyers pay HBAR along a linear curve from `startPrice` to `endPrice`. When the raise reaches
///         its target, anyone can graduate the launch exactly once: the creator receives a capped fee, and the rest
///         of the HBAR plus reserved tokens seed a SaucerSwap V1 HBAR/token pool at the curve's current price. The LP
///         tokens stay in this contract forever (locked liquidity). Buyers and the creator claim their tokens by
///         HIP-904 airdrop. If the deadline passes first, buyers are refunded.
/// @dev Inside the Hedera EVM msg.value and balances are tinybars. HTS amounts are int64; every response code is
///      checked. Agents buy through the `launchpad-buy` action module, priced against their USD caps.
contract TokenLaunchpad is ReentrancyGuard {
    address internal constant HTS = address(0x167);
    address internal constant EXCHANGE_RATE = address(0x168);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days
    uint64 public constant MIN_DURATION = 60;
    uint64 public constant MAX_DURATION = 30 days;
    uint16 public constant MAX_CREATOR_FEE_BPS = 1000; // 10%
    uint256 internal constant MAX_PRICE = 1e15; // tinybars per whole token (10M HBAR)

    ISaucerSwapV1Router public immutable router;
    ISaucerSwapV1Factory public immutable dexFactory;
    address public immutable whbar;

    struct Launch {
        address creator;
        address token;
        address pair; // SaucerSwap pool, set at graduation
        uint8 decimals;
        bool graduated;
        bool creatorClaimed;
        uint16 creatorFeeBps;
        uint64 deadline;
        uint64 supply; // smallest units
        uint64 curveSupply; // sold along the curve
        uint64 sold;
        uint64 poolTokens; // tokens added to the pool at graduation
        uint128 startPrice; // tinybars per whole token at 0 sold
        uint128 endPrice; // tinybars per whole token when curveSupply is sold
        uint128 target; // tinybars to raise for graduation
        uint128 raised;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint8 decimals;
        uint64 supply;
        uint64 curveSupply;
        uint128 startPrice;
        uint128 endPrice;
        uint128 target;
        uint16 creatorFeeBps;
        uint64 duration;
    }

    Launch[] internal _launches;
    /// @notice launchId => buyer => token units bought / tinybars paid (zeroed on claim or refund)
    mapping(uint256 => mapping(address => uint64)) public bought;
    mapping(uint256 => mapping(address => uint128)) public paid;

    event Launched(uint256 indexed id, address indexed creator, address token, uint64 supply, uint64 curveSupply);
    event Bought(uint256 indexed id, address indexed buyer, uint64 amount, uint128 cost);
    event Graduated(
        uint256 indexed id,
        address pair,
        uint256 hbarToPool,
        uint256 tokensToPool,
        uint256 liquidity,
        uint256 creatorFee
    );
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
    error InsufficientFeePayment(uint256 feeSpent);
    error RaiseBelowPoolFee(uint256 available, uint256 poolFee);

    constructor(ISaucerSwapV1Router router_) {
        router = router_;
        dexFactory = ISaucerSwapV1Factory(router_.factory());
        whbar = router_.whbar();
    }

    /// @notice Creates the token and opens its sale. Send enough HBAR to cover the HTS token-creation fee; any
    ///         unspent part is returned to the creator.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (uint256 id, address token) {
        if (
            bytes(p.name).length == 0 || bytes(p.symbol).length == 0 || p.decimals > 18 || p.supply == 0
                || p.supply > uint64(type(int64).max) || p.curveSupply == 0 || p.curveSupply >= p.supply
                || p.startPrice == 0 || p.endPrice < p.startPrice || p.endPrice > MAX_PRICE || p.target == 0
                || p.creatorFeeBps > MAX_CREATOR_FEE_BPS || p.duration < MIN_DURATION || p.duration > MAX_DURATION
                || _curveCost(p.startPrice, p.endPrice, p.curveSupply, p.decimals, 0, p.curveSupply) < p.target
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
        uint256 feeSpent = balanceBefore - address(this).balance; // balanceBefore already includes msg.value
        if (msg.value > feeSpent) _sendHbar(msg.sender, msg.value - feeSpent);

        id = _launches.length;
        _launches.push(
            Launch({
                creator: msg.sender,
                token: token,
                pair: address(0),
                decimals: p.decimals,
                graduated: false,
                creatorClaimed: false,
                creatorFeeBps: p.creatorFeeBps,
                deadline: uint64(block.timestamp) + p.duration,
                supply: p.supply,
                curveSupply: p.curveSupply,
                sold: 0,
                poolTokens: 0,
                startPrice: p.startPrice,
                endPrice: p.endPrice,
                target: p.target,
                raised: 0
            })
        );
        emit Launched(id, msg.sender, token, p.supply, p.curveSupply);
    }

    /// @notice Buys `amount` smallest units; msg.value must equal `quote(id, amount)` exactly.
    function buy(uint256 id, uint64 amount) external payable nonReentrant {
        Launch storage l = _launch(id);
        if (l.graduated || block.timestamp >= l.deadline) revert SaleClosed();
        if (amount == 0 || amount > l.curveSupply - l.sold) revert SoldOut();
        uint256 cost = _curveCost(l.startPrice, l.endPrice, l.curveSupply, l.decimals, l.sold, amount);
        if (cost == 0 || msg.value != cost) revert WrongPayment(cost);
        l.sold += amount;
        l.raised += uint128(cost);
        bought[id][msg.sender] += amount;
        paid[id][msg.sender] += uint128(cost);
        emit Bought(id, msg.sender, amount, uint128(cost));
    }

    /// @notice Permissionless, once. Pays the creator fee and seeds a SaucerSwap V1 HBAR/token pool with the rest of
    ///         the raise and reserved tokens at the curve's current price. LP tokens stay locked here.
    function graduate(uint256 id) external nonReentrant {
        Launch storage l = _launch(id);
        if (l.graduated) revert AlreadyGraduated();
        if (l.raised < l.target) revert TargetNotReached();
        l.graduated = true; // effects first: a second call can never run again

        uint256 creatorFee = uint256(l.raised) * l.creatorFeeBps / 10_000;
        uint256 hbarForPool = l.raised - creatorFee;
        address pair = dexFactory.getPair(l.token, whbar);
        uint256 poolFee =
            pair == address(0) ? IExchangeRate(EXCHANGE_RATE).tinycentsToTinybars(dexFactory.pairCreateFee()) : 0;
        if (hbarForPool <= poolFee) revert RaiseBelowPoolFee(hbarForPool, poolFee);

        // Tokens priced at the curve's current price so the pool opens where the curve ended.
        uint256 reserve = l.supply - l.curveSupply;
        uint256 price = _priceAt(l.startPrice, l.endPrice, l.curveSupply, l.sold);
        uint256 tokens = (hbarForPool - poolFee) * (10 ** uint256(l.decimals)) / price;
        if (tokens > reserve) tokens = reserve;
        if (tokens == 0) revert InvalidLaunch();

        uint256 balanceBefore = address(this).balance;
        IERC20(l.token).approve(address(router), tokens);
        (uint256 amountToken, uint256 amountHbar, uint256 liquidity) = pair == address(0)
            ? router.addLiquidityETHNewPool{ value: hbarForPool }(
                l.token, tokens, tokens, 0, address(this), block.timestamp
            )
            : router.addLiquidityETH{ value: hbarForPool }(
                l.token, tokens, tokens * 9 / 10, (hbarForPool * 9) / 10, address(this), block.timestamp
            );
        IERC20(l.token).approve(address(router), 0);
        if (pair == address(0)) pair = dexFactory.getPair(l.token, whbar);
        l.pair = pair;
        l.poolTokens = uint64(amountToken);

        // Whatever the router did not use (and the fee) goes to the creator; never more than this launch's raise.
        uint256 spent = balanceBefore - address(this).balance;
        uint256 toCreator = l.raised - spent;
        emit Graduated(id, pair, amountHbar, amountToken, liquidity, creatorFee);
        if (toCreator != 0) _sendHbar(l.creator, toCreator);
    }

    /// @notice After graduation: buyers receive what they bought; the creator receives the unsold curve tokens and
    ///         the reserve not used for the pool. Delivered by HIP-904 airdrop.
    /// @dev A contract-initiated airdrop's fee is charged to this contract; the claimer funds it with msg.value and
    ///      gets the unspent part back. The claim reverts rather than let the fee touch other launches' HBAR.
    function claim(uint256 id) external payable nonReentrant {
        Launch storage l = _launch(id);
        if (!l.graduated) revert NotGraduated();
        uint64 amount = bought[id][msg.sender];
        bought[id][msg.sender] = 0;
        if (msg.sender == l.creator && !l.creatorClaimed) {
            l.creatorClaimed = true;
            amount += l.supply - l.sold - l.poolTokens;
        }
        if (amount == 0) revert NothingToClaim();
        uint256 balanceBefore = address(this).balance;
        _airdrop(l.token, msg.sender, amount);
        uint256 feeSpent = balanceBefore - address(this).balance;
        if (feeSpent > msg.value) revert InsufficientFeePayment(feeSpent);
        emit Claimed(id, msg.sender, amount);
        if (msg.value > feeSpent) _sendHbar(msg.sender, msg.value - feeSpent);
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

    /// @dev HBAR may arrive only from HTS (unspent token-creation fee) and the router (unused liquidity HBAR).
    receive() external payable {
        if (msg.sender != HTS && msg.sender != address(router)) revert NativeTransferFailed();
    }

    // ------------------------------------------------------------------ views

    function quote(uint256 id, uint64 amount) external view returns (uint256 tinybars) {
        Launch storage l = _launch(id);
        return _curveCost(l.startPrice, l.endPrice, l.curveSupply, l.decimals, l.sold, amount);
    }

    /// @notice Current curve price in tinybars per whole token.
    function currentPrice(uint256 id) external view returns (uint256) {
        Launch storage l = _launch(id);
        return _priceAt(l.startPrice, l.endPrice, l.curveSupply, l.sold);
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

    function _priceAt(uint256 p0, uint256 p1, uint256 curveSupply, uint256 sold) internal pure returns (uint256) {
        return p0 + (p1 - p0) * sold / curveSupply;
    }

    /// @dev Exact integral of the linear price over [sold, sold + amount], rounded up so buyers never underpay.
    ///      cost = amount·p0/U + (p1−p0)·amount·(2·sold + amount) / (2·curveSupply·U), U = 10^decimals.
    function _curveCost(uint256 p0, uint256 p1, uint256 curveSupply, uint8 decimals, uint256 sold, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        uint256 den = 2 * curveSupply * (10 ** uint256(decimals));
        uint256 num = amount * p0 * 2 * curveSupply + (p1 - p0) * amount * (2 * sold + amount);
        return (num + den - 1) / den;
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
