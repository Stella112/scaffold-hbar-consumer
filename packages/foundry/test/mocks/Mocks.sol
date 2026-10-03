// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPriceOracle } from "../../contracts/interfaces/IPriceOracle.sol";
import { IHederaTokenService } from "../../contracts/interfaces/IHederaTokenService.sol";
import { ISupraSValueFeed } from "../../contracts/interfaces/ISupraSValueFeed.sol";

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
        airdropCalls++;
        lastToken = lists[0].token;
        lastSender = lists[0].transfers[0].accountID;
        lastReceiver = lists[0].transfers[1].accountID;
        lastAmount = lists[0].transfers[1].amount;
        return responseCode;
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
