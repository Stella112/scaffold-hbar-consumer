// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPriceOracle } from "../../contracts/interfaces/IPriceOracle.sol";
import { IHederaTokenService } from "../../contracts/interfaces/IHederaTokenService.sol";

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
