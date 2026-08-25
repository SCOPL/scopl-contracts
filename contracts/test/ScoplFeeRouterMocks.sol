// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRouterCallback {
    function claimV3(uint256 tokenId, bool unwrapWeth) external;
}

interface IMockCentralReferralRewards {
    enum RevenueSource { LpClaim, LimitOrder }
    function referrerOf(address referred) external view returns (address);
    function creditReward(
        bytes32 revenueId,
        address referrer,
        address referred,
        address token,
        uint256 amount,
        RevenueSource source
    ) external payable;
}

contract MockRevenueDistributor {
    address public treasury;
    address public referralRewards;

    constructor(address initialTreasury) {
        treasury = initialTreasury;
    }

    function setTreasury(address nextTreasury) external {
        treasury = nextTreasury;
    }

    function setReferralRewards(address nextRewards) external {
        referralRewards = nextRewards;
    }

    function distribute(
        bytes32 revenueId,
        address payer,
        address token,
        uint256 amount
    ) external payable {
        if (token == address(0)) {
            require(msg.value == amount, "value");
        } else {
            MockERC20(token).transferFrom(msg.sender, address(this), amount);
        }
        uint256 rewardAmount;
        address referrerSnapshot;
        address rewards = referralRewards;
        if (rewards != address(0)) {
            try IMockCentralReferralRewards(rewards).referrerOf(payer)
                returns (address referrer)
            {
                if (referrer != address(0)) {
                    referrerSnapshot = referrer;
                    rewardAmount = amount * 3_000 / 10_000;
                }
            } catch {}
        }
        if (rewardAmount != 0) {
            bool credited;
            if (token == address(0)) {
                try IMockCentralReferralRewards(rewards).creditReward{
                    value: rewardAmount
                }(
                    keccak256(abi.encode(address(this), revenueId)),
                    referrerSnapshot,
                    payer,
                    token,
                    rewardAmount,
                    IMockCentralReferralRewards.RevenueSource.LpClaim
                ) { credited = true; } catch {}
            } else {
                MockERC20(token).approve(rewards, rewardAmount);
                try IMockCentralReferralRewards(rewards).creditReward(
                    keccak256(abi.encode(address(this), revenueId)),
                    referrerSnapshot,
                    payer,
                    token,
                    rewardAmount,
                    IMockCentralReferralRewards.RevenueSource.LpClaim
                ) { credited = true; } catch {}
                MockERC20(token).approve(rewards, 0);
            }
            if (!credited) rewardAmount = 0;
        }
        uint256 remainder = amount - rewardAmount;
        if (token == address(0)) {
            (bool success, ) = treasury.call{value: remainder}("");
            require(success, "native");
        } else {
            MockERC20(token).transfer(treasury, remainder);
        }
    }
}

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;
    uint16 public transferFeeBps;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals) {
        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setFailTransfers(bool shouldFail) external {
        failTransfers = shouldFail;
    }

    function setTransferFeeBps(uint16 nextFeeBps) external {
        require(nextFeeBps <= 2_000, "fee");
        transferFeeBps = nextFeeBps;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackAttempted = false;
        callbackSucceeded = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 currentAllowance = allowance[sender][msg.sender];
        require(currentAllowance >= amount, "allowance");
        allowance[sender][msg.sender] = currentAllowance - amount;
        uint256 senderBalance = balanceOf[sender];
        require(senderBalance >= amount, "balance");
        balanceOf[sender] = senderBalance - amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) public returns (bool) {
        if (failTransfers) return false;
        uint256 senderBalance = balanceOf[msg.sender];
        require(senderBalance >= amount, "balance");
        balanceOf[msg.sender] = senderBalance - amount;
        uint256 received = amount - amount * transferFeeBps / 10_000;
        balanceOf[recipient] += received;
        if (callbackTarget != address(0)) {
            callbackAttempted = true;
            (callbackSucceeded, ) = callbackTarget.call(callbackData);
        }
        return true;
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 senderBalance = balanceOf[msg.sender];
        require(senderBalance >= amount, "balance");
        balanceOf[msg.sender] = senderBalance - amount;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "native transfer");
    }
}

contract BrokenBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        revert("broken balance");
    }
}

contract GasBombBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        assembly {
            for { } 1 { } { }
        }
    }
}

contract RevertingReferralRewards {
    fallback() external {
        revert("referral unavailable");
    }
}

contract MockV3PositionManager {
    struct Position {
        address owner;
        address approved;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 owed0;
        uint256 owed1;
        uint256 pendingFee0;
        uint256 pendingFee1;
        uint256 principal0;
        uint256 principal1;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    mapping(uint256 => Position) public position;

    function mintPosition(
        uint256 tokenId,
        address positionOwner,
        address token0,
        address token1,
        uint128 liquidity
    ) external {
        position[tokenId] = Position({
            owner: positionOwner,
            approved: address(0),
            token0: token0,
            token1: token1,
            fee: 3_000,
            tickLower: -600,
            tickUpper: 600,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0,
            pendingFee0: 0,
            pendingFee1: 0,
            principal0: 0,
            principal1: 0
        });
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address positionOwner = position[tokenId].owner;
        require(positionOwner != address(0), "missing");
        return positionOwner;
    }

    function approve(address operator, uint256 tokenId) external {
        require(position[tokenId].owner == msg.sender, "owner");
        position[tokenId].approved = operator;
    }

    function transferPosition(uint256 tokenId, address nextOwner) external {
        Position storage current = position[tokenId];
        require(current.owner == msg.sender, "owner");
        current.owner = nextOwner;
        current.approved = address(0);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage current = position[tokenId];
        return (
            0,
            current.approved,
            current.token0,
            current.token1,
            current.fee,
            current.tickLower,
            current.tickUpper,
            current.liquidity,
            0,
            0,
            uint128(current.owed0),
            uint128(current.owed1)
        );
    }

    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Position storage current = position[tokenId];
        current.pendingFee0 += amount0;
        current.pendingFee1 += amount1;
        MockERC20(current.token0).mint(address(this), amount0);
        MockERC20(current.token1).mint(address(this), amount1);
    }

    function setPrincipal(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Position storage current = position[tokenId];
        current.principal0 = amount0;
        current.principal1 = amount1;
        MockERC20(current.token0).mint(address(this), amount0);
        MockERC20(current.token1).mint(address(this), amount1);
    }

    function forceLiquidity(uint256 tokenId, uint128 liquidity) external {
        position[tokenId].liquidity = liquidity;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage current = position[params.tokenId];
        _requireApproved(current);
        uint256 total0 = current.owed0 + current.pendingFee0;
        uint256 total1 = current.owed1 + current.pendingFee1;
        amount0 = _min(total0, params.amount0Max);
        amount1 = _min(total1, params.amount1Max);
        current.owed0 = total0 - amount0;
        current.owed1 = total1 - amount1;
        current.pendingFee0 = 0;
        current.pendingFee1 = 0;
        require(
            MockERC20(current.token0).transfer(params.recipient, amount0),
            "token0 transfer"
        );
        require(
            MockERC20(current.token1).transfer(params.recipient, amount1),
            "token1 transfer"
        );
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage current = position[params.tokenId];
        _requireApproved(current);
        require(block.timestamp <= params.deadline, "deadline");
        require(params.liquidity <= current.liquidity, "liquidity");
        current.owed0 += current.pendingFee0;
        current.owed1 += current.pendingFee1;
        current.pendingFee0 = 0;
        current.pendingFee1 = 0;
        amount0 = current.principal0 * params.liquidity / current.liquidity;
        amount1 = current.principal1 * params.liquidity / current.liquidity;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "slippage");
        current.principal0 -= amount0;
        current.principal1 -= amount1;
        current.liquidity -= params.liquidity;
        current.owed0 += amount0;
        current.owed1 += amount1;
    }

    function burn(uint256 tokenId) external payable {
        Position storage current = position[tokenId];
        _requireApproved(current);
        require(current.liquidity == 0 && current.owed0 == 0 && current.owed1 == 0, "active");
        delete position[tokenId];
    }

    function _requireApproved(Position storage current) private view {
        require(msg.sender == current.owner || msg.sender == current.approved, "approval");
    }

    function _min(uint256 left, uint256 right) private pure returns (uint256) {
        return left < right ? left : right;
    }
}

contract MockV4PoolManager {
    receive() external payable {}

    function pay(address recipient, uint256 amount) external {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "native transfer");
    }
}

contract MockV4PositionManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct Position {
        address owner;
        address approved;
        PoolKey key;
        uint128 liquidity;
        uint256 fees0;
        uint256 fees1;
        uint256 principal0;
        uint256 principal1;
    }

    mapping(uint256 => Position) public position;
    MockV4PoolManager public immutable poolManager;

    constructor() {
        poolManager = new MockV4PoolManager();
    }

    function mintPosition(
        uint256 tokenId,
        address positionOwner,
        address currency0,
        address currency1,
        uint128 liquidity
    ) external {
        position[tokenId] = Position({
            owner: positionOwner,
            approved: address(0),
            key: PoolKey(currency0, currency1, 3_000, 60, address(0)),
            liquidity: liquidity,
            fees0: 0,
            fees1: 0,
            principal0: 0,
            principal1: 0
        });
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address positionOwner = position[tokenId].owner;
        require(positionOwner != address(0), "missing");
        return positionOwner;
    }

    function approve(address operator, uint256 tokenId) external {
        require(position[tokenId].owner == msg.sender, "owner");
        position[tokenId].approved = operator;
    }

    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, uint256 info)
    {
        return (position[tokenId].key, 1);
    }

    function getPositionLiquidity(uint256 tokenId)
        external
        view
        returns (uint128 liquidity)
    {
        return position[tokenId].liquidity;
    }

    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external payable {
        Position storage current = position[tokenId];
        current.fees0 += amount0;
        current.fees1 += amount1;
        _fund(current.key.currency0, amount0);
        _fund(current.key.currency1, amount1);
    }

    function setPrincipal(uint256 tokenId, uint256 amount0, uint256 amount1) external payable {
        Position storage current = position[tokenId];
        current.principal0 = amount0;
        current.principal1 = amount1;
        _fund(current.key.currency0, amount0);
        _fund(current.key.currency1, amount1);
    }

    function forceLiquidity(uint256 tokenId, uint128 liquidity) external {
        position[tokenId].liquidity = liquidity;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable
    {
        require(block.timestamp <= deadline, "deadline");
        (bytes memory actions, bytes[] memory params) =
            abi.decode(unlockData, (bytes, bytes[]));
        uint8 action = uint8(actions[0]);
        uint256 tokenId;
        uint256 liquidity;
        if (action == 0x00 || action == 0x01) {
            (tokenId, liquidity, , , ) =
                abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        } else {
            (tokenId, , , ) =
                abi.decode(params[0], (uint256, uint128, uint128, bytes));
        }
        Position storage current = position[tokenId];
        _requireApproved(current);
        (, , address recipient) =
            abi.decode(params[1], (address, address, address));

        if (action == 0x00) {
            _payPair(current, recipient, current.fees0, current.fees1);
            current.fees0 = 0;
            current.fees1 = 0;
            return;
        }

        uint128 removed = action == 0x03
            ? current.liquidity
            : uint128(liquidity);
        require(removed <= current.liquidity, "liquidity");
        uint256 amount0 = current.principal0 * removed / current.liquidity;
        uint256 amount1 = current.principal1 * removed / current.liquidity;
        current.principal0 -= amount0;
        current.principal1 -= amount1;
        current.liquidity -= removed;
        _payPair(current, recipient, amount0, amount1);
        if (action == 0x03) delete position[tokenId];
    }

    function burn(uint256 tokenId) external payable {
        Position storage current = position[tokenId];
        _requireApproved(current);
        require(current.liquidity == 0, "active");
        delete position[tokenId];
    }

    function _fund(address currency, uint256 amount) private {
        if (currency == address(0)) {
            require(msg.value >= amount, "native funding");
            (bool success, ) = address(poolManager).call{value: amount}("");
            require(success, "native funding transfer");
        } else {
            MockERC20(currency).mint(address(this), amount);
        }
    }

    function _payPair(
        Position storage current,
        address recipient,
        uint256 amount0,
        uint256 amount1
    ) private {
        _pay(current.key.currency0, recipient, amount0);
        _pay(current.key.currency1, recipient, amount1);
    }

    function _pay(address currency, address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (currency == address(0)) {
            poolManager.pay(recipient, amount);
        } else {
            require(
                MockERC20(currency).transfer(recipient, amount),
                "token transfer"
            );
        }
    }

    function _requireApproved(Position storage current) private view {
        require(msg.sender == current.owner || msg.sender == current.approved, "approval");
    }
}
