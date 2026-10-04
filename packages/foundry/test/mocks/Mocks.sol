// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";
import { IPriceOracle } from "../../contracts/interfaces/IPriceOracle.sol";
import { IHederaTokenService } from "../../contracts/interfaces/IHederaTokenService.sol";
import { ISupraSValueFeed } from "../../contracts/interfaces/ISupraSValueFeed.sol";
import { IActionModule } from "../../contracts/interfaces/IActionModule.sol";

/// Test-only. Plain ERC-20 standing in for the HTS ERC-20 facade in local unit tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Test-only. Fixed USD6 price per whole unit; never used by testnet proofs.
contract MockOracle is IPriceOracle {
    struct Feed {
        bool ok;
        uint256 usd6PerUnit;
        uint8 decimals;
    }

    mapping(address => Feed) public feeds;

    function setFeed(address asset, uint256 usd6PerUnit, uint8 decimals_) external {
        feeds[asset] = Feed(true, usd6PerUnit, decimals_);
    }

    function disable(address asset) external {
        feeds[asset].ok = false;
    }

    function quoteUsd6(address asset, uint256 amount) external view returns (bool ok, uint256 usd6) {
        Feed memory f = feeds[asset];
        if (!f.ok) return (false, 0);
        return (true, amount * f.usd6PerUnit / (10 ** f.decimals));
    }
}

/// Test-only. Etched at 0x167 to observe HTS calls; returns a configurable response code.
contract MockHederaTokenService {
    int64 public responseCode = 22;
    uint256 public airdropCalls;
    uint256 public associateCalls;
    address public lastToken;
    address public lastSender;
    address public lastReceiver;
    int64 public lastAmount;

    function setResponseCode(int64 rc) external {
        responseCode = rc;
    }

    function associateToken(address, address token) external returns (int64) {
        associateCalls++;
        lastToken = token;
        return responseCode;
    }

    function airdropTokens(IHederaTokenService.TokenTransferList[] memory lists) external returns (int64) {
        // Hedera charges the calling contract's balance; reject like INSUFFICIENT_PAYER_BALANCE (10) when it can't pay.
        if (msg.sender.balance < airdropFeeRequired) return 10;
        // Like Hedera, charge the airdrop fee to the calling contract's own HBAR (via a cheatcode in tests).
        if (airdropHbarFee != 0) {
            Vm(address(uint160(uint256(keccak256("hevm cheat code")))))
                .deal(msg.sender, msg.sender.balance - airdropHbarFee);
        }
        airdropCalls++;
        lastToken = lists[0].token;
        lastSender = lists[0].transfers[0].accountID;
        lastReceiver = lists[0].transfers[1].accountID;
        lastAmount = lists[0].transfers[1].amount;
        return responseCode;
    }

    uint256 public airdropFeeRequired;
    uint256 public airdropHbarFee;

    function setAirdropHbarFee(uint256 fee) external {
        airdropHbarFee = fee;
    }

    function setAirdropFeeRequired(uint256 fee) external {
        airdropFeeRequired = fee;
    }

    // ---- token creation (fee: keeps CREATE_FEE tinybars, returns any excess like a refund)
    uint256 public constant CREATE_FEE = 10e8;
    uint256 public tokensCreated;
    address public lastTreasury;
    bool public lastFiniteSupply;
    int64 public lastMaxSupply;
    uint256 public lastKeyCount;
    int64 public lastInitialSupply;

    function createFungibleToken(IHederaTokenService.HederaToken memory token, int64 initialTotalSupply, int32)
        external
        payable
        returns (int64, address)
    {
        if (responseCode != 22) return (responseCode, address(0));
        require(msg.value >= CREATE_FEE, "INSUFFICIENT_TX_FEE");
        tokensCreated++;
        lastTreasury = token.treasury;
        lastFiniteSupply = token.tokenSupplyType;
        lastMaxSupply = token.maxSupply;
        lastKeyCount = token.tokenKeys.length;
        lastInitialSupply = initialTotalSupply;
        // A real ERC-20 stands in for the HTS facade so approve / transferFrom work in tests.
        MockERC20 t = new MockERC20(token.name, token.symbol, 2);
        t.mint(token.treasury, uint256(uint64(initialTotalSupply)));
        (bool ok,) = msg.sender.call{ value: msg.value - CREATE_FEE }("");
        require(ok, "refund failed");
        return (22, address(t));
    }
}

/// Test-only. Records whether it was called, to prove a call never happened.
contract CallTarget {
    uint256 public hits;

    function hit() external payable {
        hits++;
    }
}

/// Test-only. Exact-output router that pulls `quotedIn` of tokenIn and pays `deliver` of tokenOut.
/// `deliver` and `quotedIn` can be skewed to simulate a misbehaving router.
contract MockSwapRouter {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    MockERC20 public immutable tokenIn;
    MockERC20 public immutable tokenOut;
    uint256 public quotedIn;
    int256 public deliverSkew;
    bool public ignoreMax;

    constructor(MockERC20 tokenIn_, MockERC20 tokenOut_, uint256 quotedIn_) {
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        quotedIn = quotedIn_;
    }

    function setDeliverSkew(int256 skew) external {
        deliverSkew = skew;
    }

    function setIgnoreMax(bool v) external {
        ignoreMax = v;
    }

    function exactOutput(ExactOutputParams calldata p) external payable returns (uint256 amountIn) {
        require(block.timestamp <= p.deadline, "expired");
        amountIn = quotedIn;
        require(ignoreMax || amountIn <= p.amountInMaximum, "slippage");
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        tokenOut.mint(p.recipient, uint256(int256(p.amountOut) + deliverSkew));
        if (ignoreMax) return p.amountInMaximum + 1;
    }
}

/// Test-only. Settable Supra push-feed storage; never used by testnet proofs.
contract MockSupraFeed is ISupraSValueFeed {
    mapping(uint256 => priceFeed) internal _feeds;
    bool public reverts;

    function set(uint256 pairIndex, uint256 price, uint256 decimals, uint256 timeMs) external {
        _feeds[pairIndex] = priceFeed({ round: timeMs, decimals: decimals, time: timeMs, price: price });
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function getSvalue(uint256 pairIndex) external view returns (priceFeed memory) {
        require(!reverts, "feed down");
        return _feeds[pairIndex];
    }
}

/// Test-only. Records scheduleCall requests at 0x16b (etched); never used by testnet proofs.
contract MockScheduleService {
    int64 public responseCode = 22;
    uint256 public calls;
    address public lastTo;
    uint256 public lastExpiry;
    uint256 public lastGas;
    bytes public lastData;
    address public lastDeleted;

    function setResponseCode(int64 rc) external {
        responseCode = rc;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64, bytes memory callData)
        external
        returns (int64, address)
    {
        calls++;
        (lastTo, lastExpiry, lastGas, lastData) = (to, expirySecond, gasLimit, callData);
        return (responseCode, address(uint160(0x5c4ed000 + calls)));
    }

    function deleteSchedule(address scheduleAddress) external returns (int64) {
        lastDeleted = scheduleAddress;
        return 22;
    }
}

/// Test-only action module: plans one ERC-20 transfer, optionally lying about how much it spends.
contract MockTransferModule is IActionModule {
    address public token;
    uint256 public actualMultiplier = 1;
    bool public callAccount;

    constructor(address token_) {
        token = token_;
    }

    function setLie(uint256 multiplier, bool callAccount_) external {
        actualMultiplier = multiplier;
        callAccount = callAccount_;
    }

    function plan(address account, bytes calldata actionData)
        external
        view
        returns (address, address, uint256, PlannedCall[] memory calls)
    {
        (address to, uint256 amount) = abi.decode(actionData, (address, uint256));
        calls = new PlannedCall[](1);
        calls[0] = callAccount
            ? PlannedCall({ target: account, value: 0, data: abi.encodeWithSignature("setOwner(address)", to) })
            : PlannedCall({
                target: token,
                value: 0,
                data: abi.encodeWithSignature("transfer(address,uint256)", to, amount * actualMultiplier)
            });
        return (token, to, amount, calls);
    }
}

/// Test-only Hedera exchange-rate system contract (etched at 0x168): 10 US cents per HBAR.
contract MockExchangeRate {
    function tinycentsToTinybars(uint256 tinycents) external pure returns (uint256) {
        return tinycents / 10;
    }
}

/// Test-only SaucerSwap V1 factory: $2 pool creation fee, like testnet.
contract MockSaucerSwapV1Factory {
    uint256 public pairCreateFee = 2e10; // tinycents
    mapping(address => mapping(address => address)) public getPair;
    uint256 internal pairs;

    function createPair(address a, address b) external returns (address pair) {
        require(getPair[a][b] == address(0), "POOL ALREADY EXISTS");
        pair = address(uint160(0xBA1A000 + ++pairs));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

/// Test-only SaucerSwap V1 router: pays the pool fee from msg.value, pulls tokens into the pair, keeps the HBAR.
contract MockSaucerSwapV1Router {
    MockSaucerSwapV1Factory public immutable factory;
    address public immutable whbar;
    uint256 public lastHbar;
    uint256 public lastTokens;
    address public lastTo;

    constructor(MockSaucerSwapV1Factory factory_, address whbar_) {
        factory = factory_;
        whbar = whbar_;
    }

    function addLiquidityETHNewPool(address token, uint256 amountTokenDesired, uint256, uint256, address to, uint256)
        external
        payable
        returns (uint256, uint256, uint256)
    {
        uint256 fee = MockExchangeRate(address(0x168)).tinycentsToTinybars(factory.pairCreateFee());
        require(msg.value > fee, "UniswapV2Router: MSG.VALUE");
        address pair = factory.createPair(token, whbar);
        return _add(token, pair, amountTokenDesired, msg.value - fee, to);
    }

    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256, uint256, address to, uint256)
        external
        payable
        returns (uint256, uint256, uint256)
    {
        address pair = factory.getPair(token, whbar);
        require(pair != address(0), "no pair");
        return _add(token, pair, amountTokenDesired, msg.value, to);
    }

    function _add(address token, address pair, uint256 tokens, uint256 hbar, address to)
        internal
        returns (uint256, uint256, uint256)
    {
        require(IERC20(token).transferFrom(msg.sender, pair, tokens), "transferFrom");
        (lastHbar, lastTokens, lastTo) = (hbar, tokens, to);
        return (tokens, hbar, tokens + hbar);
    }
}
