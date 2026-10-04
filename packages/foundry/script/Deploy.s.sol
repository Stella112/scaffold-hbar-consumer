//SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { AccountFactoryDeployer } from "../contracts/AccountFactoryDeployer.sol";
import { ConsumerAccountFactory } from "../contracts/ConsumerAccountFactory.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";

/**
 * @notice Deploys the ConsumerAccountFactory.
 * @dev PRICE_ORACLE (optional) is the oracle new accounts start with. Without it, session spend fails closed
 *      with PriceUnavailable until the owner sets an oracle.
 *
 * Example: yarn foundry:deploy --network hedera_testnet
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        address oracle = vm.envOr("PRICE_ORACLE", address(0));
        ConsumerAccountFactory factory = AccountFactoryDeployer.deploy(IPriceOracle(oracle));
        deployments.push(Deployment({ name: "ConsumerAccountFactory", addr: address(factory) }));
    }
}
