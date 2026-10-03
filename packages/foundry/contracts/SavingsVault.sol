// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";

/// @title SavingsVault
/// @notice ERC-4626 savings vault for one HTS token (through its ERC-20 facade). No admin, no strategy: assets stay in
///         the vault and anyone may donate to raise the share price. Agents with a ConsumerAccount session can deposit
///         (typed `vault-deposit` action, USD-capped) but never withdraw or move shares; only the owner redeems.
/// @dev Hedera requires the vault to be associated with the token before it can hold it; the constructor does that
///      and checks the response code. A decimals offset of 9 (virtual shares) defeats the first-depositor inflation
///      attack.
contract SavingsVault is ERC4626 {
    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;

    error HtsCallFailed(int64 responseCode);

    constructor(IERC20 asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC4626(asset_) {
        int64 rc = IHederaTokenService(HTS).associateToken(address(this), address(asset_));
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 9;
    }
}
