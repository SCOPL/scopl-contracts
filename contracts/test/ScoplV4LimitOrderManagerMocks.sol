// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IV4CentralReferral {
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

contract V4LimitOrderMockPolicy {
    enum OrderSource { Direct, Integration }
    struct TierAttestation {
        address user;
        uint256 destinationChainId;
        uint16 beneficiaryShareBps;
        uint48 expiry;
    }
    struct ResolvedOrderPolicy {
        OrderSource source;
        bytes32 integrationId;
        address beneficiary;
        uint16 beneficiaryShareBps;
        address integratorFeeRecipient;
        uint16 integratorShareBps;
        uint16 protocolShareBps;
        address referrer;
    }
    address public integrationRecipient;
    address public directReferrer;
    uint16 public directShareBps = 1_000;
    uint16 public integrationUserShareBps = 2_500;

    function setIntegrationRecipient(address recipient) external {
        integrationRecipient = recipient;
    }
    function setIntegrationPolicy(address recipient, uint16 userShareBps)
        external
    {
        integrationRecipient = recipient;
        integrationUserShareBps = userShareBps;
    }
    function setDirectPolicy(uint16 shareBps, address referrer) external {
        directShareBps = shareBps;
        directReferrer = referrer;
    }
    function resolveOrderPolicy(
        address user,
        bytes32 integrationId,
        address,
        TierAttestation calldata,
        bytes calldata
    ) external view returns (ResolvedOrderPolicy memory resolved) {
        if (integrationId == bytes32(0)) {
            return ResolvedOrderPolicy(
                OrderSource.Direct, bytes32(0), user, directShareBps,
                address(0), 0, uint16(10_000 - directShareBps), directReferrer
            );
        }
        return ResolvedOrderPolicy(
            OrderSource.Integration, integrationId, user,
            integrationUserShareBps, integrationRecipient,
            uint16(7_500 - integrationUserShareBps), 2_500, address(0)
        );
    }
}

contract V4LimitOrderMockERC20 {
    error Permit2AllowanceIsFixedAtInfinity();

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) private allowances;
    address public fixedInfiniteAllowanceSpender;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function setFixedInfiniteAllowanceSpender(address spender) external {
        fixedInfiniteAllowanceSpender = spender;
    }

    function allowance(address owner, address spender)
        external
        view
        returns (uint256)
    {
        if (spender == fixedInfiniteAllowanceSpender) {
            return type(uint256).max;
        }
        return allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (
            spender == fixedInfiniteAllowanceSpender &&
            amount != type(uint256).max
        ) revert Permit2AllowanceIsFixedAtInfinity();
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 allowed = msg.sender == fixedInfiniteAllowanceSpender
            ? type(uint256).max
            : allowances[sender][msg.sender];
        if (allowed != type(uint256).max) {
            allowances[sender][msg.sender] = allowed - amount;
        }
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract V4LimitOrderMockRevenueDistributor {
    address public treasury;
    address public referralRewards;

    constructor(address initialTreasury) { treasury = initialTreasury; }

    function setReferralRewards(address nextRewards) external {
        referralRewards = nextRewards;
    }

    function distribute(
        bytes32 revenueId,
        address payer,
        address token,
        uint256 amount
    ) external {
        V4LimitOrderMockERC20(token).transferFrom(msg.sender, address(this), amount);
        uint256 rewardAmount;
        address referrerSnapshot;
        address rewards = referralRewards;
        if (rewards != address(0)) {
            try IV4CentralReferral(rewards).referrerOf(payer)
                returns (address referrer)
            {
                if (referrer != address(0)) {
                    referrerSnapshot = referrer;
                    rewardAmount = amount * 3_000 / 10_000;
                }
            } catch {}
        }
        if (rewardAmount != 0) {
            V4LimitOrderMockERC20(token).approve(rewards, rewardAmount);
            try IV4CentralReferral(rewards).creditReward(
                keccak256(abi.encode(address(this), revenueId)),
                referrerSnapshot,
                payer,
                token,
                rewardAmount,
                IV4CentralReferral.RevenueSource.LimitOrder
            ) {} catch { rewardAmount = 0; }
            V4LimitOrderMockERC20(token).approve(rewards, 0);
        }
        V4LimitOrderMockERC20(token).transfer(treasury, amount - rewardAmount);
    }

    function distributeAttributed(
        bytes32 revenueId,
        address payer,
        address attributedReferrer,
        address token,
        uint256 amount
    ) external {
        V4LimitOrderMockERC20(token).transferFrom(msg.sender, address(this), amount);
        uint256 rewardAmount;
        address rewards = referralRewards;
        if (rewards != address(0) && attributedReferrer != address(0)) {
            rewardAmount = amount * 3_000 / 10_000;
            V4LimitOrderMockERC20(token).approve(rewards, rewardAmount);
            try IV4CentralReferral(rewards).creditReward(
                keccak256(abi.encode(address(this), revenueId)),
                attributedReferrer,
                payer,
                token,
                rewardAmount,
                IV4CentralReferral.RevenueSource.LimitOrder
            ) {} catch { rewardAmount = 0; }
            V4LimitOrderMockERC20(token).approve(rewards, 0);
        }
        V4LimitOrderMockERC20(token).transfer(treasury, amount - rewardAmount);
    }
}

contract V4LimitOrderMockWETH is V4LimitOrderMockERC20 {
    constructor() V4LimitOrderMockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "native");
    }
}

contract V4LimitOrderMockPermit2 {
    struct PermitAllowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address => mapping(address => mapping(address => PermitAllowance)))
        public allowances;

    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external {
        allowances[msg.sender][token][spender] = PermitAllowance(amount, expiration);
    }

    function transferFrom(
        address sender,
        address recipient,
        uint160 amount,
        address token
    ) external {
        PermitAllowance storage permitted = allowances[sender][token][msg.sender];
        require(permitted.expiration >= block.timestamp, "expired");
        permitted.amount -= amount;
        V4LimitOrderMockERC20(token).transferFrom(sender, recipient, amount);
    }
}

contract V4LimitOrderMockStateView {
    address public immutable poolManager;
    address public positionManager;

    constructor(address manager) {
        poolManager = manager;
    }

    function setPositionManager(address manager) external {
        positionManager = manager;
    }

    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
    }

    mapping(bytes32 => Slot0) public slots;

    function setSlot0(bytes32 poolId, uint160 sqrtPriceX96, int24 tick) external {
        slots[poolId] = Slot0(sqrtPriceX96, tick, 0, 3_000);
    }

    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160, int24, uint24, uint24)
    {
        Slot0 memory state = slots[poolId];
        return (
            state.sqrtPriceX96,
            state.tick,
            state.protocolFee,
            state.lpFee
        );
    }

    function getPositionInfo(
        bytes32,
        address,
        int24,
        int24,
        bytes32 salt
    ) external view returns (uint128, uint256, uint256) {
        return V4LimitOrderMockPositionManager(payable(positionManager))
            .positionState(uint256(salt));
    }
}

contract V4LimitOrderMockPoolManager {}

contract V4LimitOrderMockHook {}

contract V4LimitOrderMockPositionManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct Position {
        PoolKey key;
        uint256 info;
        uint128 liquidity;
        address owner;
        uint256 amount0;
        uint256 amount1;
        uint256 fee0;
        uint256 fee1;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
    }

    V4LimitOrderMockPermit2 public immutable permit2;
    address public immutable poolManager;
    uint256 public nextTokenId = 1;
    mapping(uint256 => Position) public positions;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public getApproved;

    constructor(address permit2Address, address manager) {
        permit2 = V4LimitOrderMockPermit2(permit2Address);
        poolManager = manager;
    }

    receive() external payable {}

    function ownerOf(uint256 tokenId) external view returns (address) {
        address result = positions[tokenId].owner;
        require(result != address(0), "missing");
        return result;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function approve(address operator, uint256 tokenId) external {
        require(positions[tokenId].owner == msg.sender, "owner");
        getApproved[tokenId] = operator;
    }

    function getPositionLiquidity(uint256 tokenId)
        external
        view
        returns (uint128)
    {
        return positions[tokenId].liquidity;
    }

    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory, uint256)
    {
        Position storage position = positions[tokenId];
        return (position.key, position.info);
    }

    function positionState(uint256 tokenId)
        external
        view
        returns (uint128, uint256, uint256)
    {
        Position storage position = positions[tokenId];
        return (
            position.liquidity,
            position.feeGrowthInside0LastX128,
            position.feeGrowthInside1LastX128
        );
    }

    function setLiquidity(uint256 tokenId, uint128 liquidity) external {
        positions[tokenId].liquidity = liquidity;
    }

    function setWithdrawal(
        uint256 tokenId,
        uint256 amount0,
        uint256 amount1
    ) external {
        positions[tokenId].amount0 = amount0;
        positions[tokenId].amount1 = amount1;
    }

    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1)
        external
    {
        Position storage position = positions[tokenId];
        position.fee0 += amount0;
        position.fee1 += amount1;
        if (position.key.currency0 == address(0)) {
            require(address(this).balance >= position.fee0, "native fees");
        } else if (amount0 > 0) {
            V4LimitOrderMockERC20(position.key.currency0).mint(
                address(this),
                amount0
            );
        }
        if (position.key.currency1 == address(0)) {
            require(address(this).balance >= position.fee1, "native fees");
        } else if (amount1 > 0) {
            V4LimitOrderMockERC20(position.key.currency1).mint(
                address(this),
                amount1
            );
        }
    }

    function claimFees(uint256 tokenId) external {
        Position storage position = positions[tokenId];
        require(position.owner == msg.sender, "owner");
        _pay(position.key.currency0, msg.sender, position.fee0);
        _pay(position.key.currency1, msg.sender, position.fee1);
        if (position.fee0 > 0) position.feeGrowthInside0LastX128 += 1;
        if (position.fee1 > 0) position.feeGrowthInside1LastX128 += 1;
        position.fee0 = 0;
        position.fee1 = 0;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        (bytes memory actions, bytes[] memory params) =
            abi.decode(unlockData, (bytes, bytes[]));
        uint8 action = uint8(actions[0]);
        if (action == 0x02) {
            _mint(params[0]);
            if (actions.length == 3 && uint8(actions[2]) == 0x14) {
                uint256 used = _nativeUsed(params[0]);
                if (msg.value > used) {
                    (bool success, ) = msg.sender.call{value: msg.value - used}("");
                    require(success, "refund");
                }
            }
        } else if (action == 0x00) {
            (uint256 tokenId, , , , ) = abi.decode(
                params[0],
                (uint256, uint256, uint128, uint128, bytes)
            );
            Position storage position = positions[tokenId];
            require(
                isApprovedForAll[position.owner][msg.sender] ||
                    getApproved[tokenId] == msg.sender,
                "approval"
            );
            (, , address recipient) =
                abi.decode(params[1], (address, address, address));
            _pay(position.key.currency0, recipient, position.fee0);
            _pay(position.key.currency1, recipient, position.fee1);
            if (position.fee0 > 0) position.feeGrowthInside0LastX128 += 1;
            if (position.fee1 > 0) position.feeGrowthInside1LastX128 += 1;
            position.fee0 = 0;
            position.fee1 = 0;
        } else if (action == 0x01) {
            (
                uint256 tokenId,
                uint256 liquidity,
                ,
                ,

            ) = abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
            Position storage position = positions[tokenId];
            require(
                isApprovedForAll[position.owner][msg.sender] ||
                    getApproved[tokenId] == msg.sender,
                "approval"
            );
            position.liquidity -= uint128(liquidity);
            (, , address recipient) =
                abi.decode(params[1], (address, address, address));
            _pay(position.key.currency0, recipient, position.amount0);
            _pay(position.key.currency1, recipient, position.amount1);
            position.amount0 = 0;
            position.amount1 = 0;
        } else {
            revert("action");
        }
    }

    function _mint(bytes memory encoded) private {
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint256 liquidity,
            uint128 amount0Max,
            uint128 amount1Max,
            address positionOwner,

        ) = abi.decode(
            encoded,
            (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes)
        );
        uint256 tokenId = nextTokenId++;
        uint256 info =
            uint256(uint24(tickLower)) << 8 |
            uint256(uint24(tickUpper)) << 32;
        positions[tokenId] = Position({
            key: key,
            info: info,
            liquidity: uint128(liquidity),
            owner: positionOwner,
            amount0: amount0Max,
            amount1: amount1Max,
            fee0: 0,
            fee1: 0,
            feeGrowthInside0LastX128: 0,
            feeGrowthInside1LastX128: 0
        });
        if (key.currency0 != address(0) && amount0Max > 0) {
            permit2.transferFrom(
                msg.sender,
                address(this),
                amount0Max,
                key.currency0
            );
        }
        if (key.currency1 != address(0) && amount1Max > 0) {
            permit2.transferFrom(
                msg.sender,
                address(this),
                amount1Max,
                key.currency1
            );
        }
    }

    function _nativeUsed(bytes memory encoded) private pure returns (uint256) {
        (PoolKey memory key, , , , uint128 amount0Max, uint128 amount1Max, , ) =
            abi.decode(
                encoded,
                (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes)
            );
        return key.currency0 == address(0) ? amount0Max : amount1Max;
    }

    function _pay(address token, address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool success, ) = recipient.call{value: amount}("");
            require(success, "native");
        } else {
            V4LimitOrderMockERC20(token).transfer(recipient, amount);
        }
    }
}
