// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "./interfaces/ISupraSValueFeed.sol";

/// @title SupraPriceOracle
/// @notice IPriceOracle backed by Supra push feeds. Values session spend in USD6 for ConsumerAccount caps.
/// @dev Fails closed: unsupported asset, zero price, future or stale timestamp, or a reverting feed all return
///      ok == false. Rounds up so a cap is never under-charged. Configuration is immutable (no owner).
contract SupraPriceOracle is IPriceOracle {
    struct AssetConfig {
        bool supported;
        uint8 decimals; // decimals of `amount` passed to quoteUsd6
        uint64 pairIndex; // Supra pair index quoted in USD
    }

    /// @dev Prices beyond this are treated as invalid rather than risking overflow in valuation.
    uint256 internal constant MAX_PRICE = 1e40;
    uint256 internal constant MAX_PRICE_DECIMALS = 36;
    /// @dev Tolerated clock skew between the feed's timestamp and block.timestamp.
    uint256 internal constant MAX_FUTURE_SKEW = 60;

    ISupraSValueFeed public immutable feed;
    uint256 public immutable maxAge;
    mapping(address => AssetConfig) public assets;

    error LengthMismatch();
    error InvalidConfig();

    /// @param assets_ address(0) for HBAR (amount in tinybars, 8 decimals) or HTS token EVM addresses
    constructor(
        ISupraSValueFeed feed_,
        uint256 maxAge_,
        address[] memory assets_,
        uint64[] memory pairIndexes_,
        uint8[] memory decimals_
    ) {
        if (address(feed_) == address(0) || maxAge_ == 0) revert InvalidConfig();
        if (assets_.length != pairIndexes_.length || assets_.length != decimals_.length) revert LengthMismatch();
        feed = feed_;
        maxAge = maxAge_;
        for (uint256 i; i < assets_.length; ++i) {
            if (decimals_[i] > 36) revert InvalidConfig();
            assets[assets_[i]] = AssetConfig({ supported: true, decimals: decimals_[i], pairIndex: pairIndexes_[i] });
        }
    }

    /// @inheritdoc IPriceOracle
    function quoteUsd6(address asset, uint256 amount) external view returns (bool ok, uint256 usd6) {
        AssetConfig memory a = assets[asset];
        if (!a.supported) return (false, 0);
        try feed.getSvalue(a.pairIndex) returns (ISupraSValueFeed.priceFeed memory p) {
            if (p.price == 0 || p.price > MAX_PRICE || p.decimals > MAX_PRICE_DECIMALS) return (false, 0);
            uint256 t = p.time / 1000;
            if (t > block.timestamp + MAX_FUTURE_SKEW) return (false, 0);
            if (t + maxAge < block.timestamp) return (false, 0);
            // usd6 = ceil(amount * price * 1e6 / 10^(assetDecimals + priceDecimals))
            usd6 = Math.mulDiv(amount, p.price * 1e6, 10 ** (uint256(a.decimals) + p.decimals), Math.Rounding.Ceil);
            return (true, usd6);
        } catch {
            return (false, 0);
        }
    }
}
