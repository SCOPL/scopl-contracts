// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILimitOrderManagerCreditTest {
    function executeOrder(uint256 orderId) external;
    function setPreferWrappedNative(bool preferred) external;
}

interface ILimitOrderCentralReferral {
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

contract LimitOrderMockPolicy {
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
            return ResolvedOrderPolicy({
                source: OrderSource.Direct,
                integrationId: bytes32(0),
                beneficiary: user,
                beneficiaryShareBps: directShareBps,
                integratorFeeRecipient: address(0),
                integratorShareBps: 0,
                protocolShareBps: uint16(10_000 - directShareBps),
                referrer: directReferrer
            });
        }
        return ResolvedOrderPolicy({
            source: OrderSource.Integration,
            integrationId: integrationId,
            beneficiary: user,
            beneficiaryShareBps: integrationUserShareBps,
            integratorFeeRecipient: integrationRecipient,
            integratorShareBps: uint16(7_500 - integrationUserShareBps),
            protocolShareBps: 2_500,
            referrer: address(0)
        });
    }
}

contract RevertingLimitOrderReferral {
    fallback() external {
        revert("referral unavailable");
    }
}

contract RevertingLimitOrderBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        revert("balance unavailable");
    }
}

contract CreditWithdrawingKeeper {
    function setWrappedPreference(address manager, bool preferred) external {
        ILimitOrderManagerCreditTest(manager).setPreferWrappedNative(preferred);
    }

    function execute(address manager, uint256 orderId) external {
        ILimitOrderManagerCreditTest(manager).executeOrder(orderId);
    }

    receive() external payable {
        revert("cannot receive native");
    }
}

contract LimitOrderMockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals) {
        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        require(allowance[sender][msg.sender] >= amount, "allowance");
        require(balanceOf[sender] >= amount, "balance");
        allowance[sender][msg.sender] -= amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract LimitOrderMockRevenueDistributor {
    address public treasury;
    address public referralRewards;

    constructor(address initialTreasury) { treasury = initialTreasury; }

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
    ) external {
        LimitOrderMockERC20(token).transferFrom(msg.sender, address(this), amount);
        uint256 rewardAmount;
        address referrerSnapshot;
        address rewards = referralRewards;
        if (rewards != address(0)) {
            try ILimitOrderCentralReferral(rewards).referrerOf(payer)
                returns (address referrer)
            {
                if (referrer != address(0)) {
                    referrerSnapshot = referrer;
                    rewardAmount = amount * 3_000 / 10_000;
                }
            } catch {}
        }
        if (rewardAmount != 0) {
            LimitOrderMockERC20(token).approve(rewards, rewardAmount);
            try ILimitOrderCentralReferral(rewards).creditReward(
                keccak256(abi.encode(address(this), revenueId)),
                referrerSnapshot,
                payer,
                token,
                rewardAmount,
                ILimitOrderCentralReferral.RevenueSource.LimitOrder
            ) {} catch { rewardAmount = 0; }
            LimitOrderMockERC20(token).approve(rewards, 0);
        }
        LimitOrderMockERC20(token).transfer(treasury, amount - rewardAmount);
    }

    function distributeAttributed(
        bytes32 revenueId,
        address payer,
        address attributedReferrer,
        address token,
        uint256 amount
    ) external {
        LimitOrderMockERC20(token).transferFrom(msg.sender, address(this), amount);
        uint256 rewardAmount;
        address rewards = referralRewards;
        if (rewards != address(0) && attributedReferrer != address(0)) {
            rewardAmount = amount * 3_000 / 10_000;
            LimitOrderMockERC20(token).approve(rewards, rewardAmount);
            try ILimitOrderCentralReferral(rewards).creditReward(
                keccak256(abi.encode(address(this), revenueId)),
                attributedReferrer,
                payer,
                token,
                rewardAmount,
                ILimitOrderCentralReferral.RevenueSource.LimitOrder
            ) {} catch { rewardAmount = 0; }
            LimitOrderMockERC20(token).approve(rewards, 0);
        }
        LimitOrderMockERC20(token).transfer(treasury, amount - rewardAmount);
    }
}

contract LimitOrderMockWETH is LimitOrderMockERC20 {
    constructor() LimitOrderMockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "native");
    }

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

contract LimitOrderMockPool {
    int24 public currentTick;
    int24 public immutable tickSpacing;

    constructor(int24 spacing, int24 initialTick) {
        tickSpacing = spacing;
        currentTick = initialTick;
    }

    function setTick(int24 nextTick) external {
        currentTick = nextTick;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (uint160(1 << 96), currentTick, 0, 0, 0, 0, true);
    }
}

contract LimitOrderMockFactory {
    mapping(bytes32 => address) public pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool)
        external
    {
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        pools[keccak256(abi.encode(token0, token1, fee))] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee)
        external
        view
        returns (address)
    {
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        return pools[keccak256(abi.encode(token0, token1, fee))];
    }
}

contract LimitOrderMockPositionManager {
    struct Position {
        address owner;
        address approved;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 principal;
        uint256 owed0;
        uint256 owed1;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        bool inputWasToken0;
    }

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
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

    LimitOrderMockFactory public immutable factory;
    address public immutable WETH9;
    uint256 public nextTokenId = 1;
    mapping(uint256 => Position) public position;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor(address mockFactory, address wrappedNative) {
        factory = LimitOrderMockFactory(mockFactory);
        WETH9 = wrappedNative;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function approve(address operator, uint256 tokenId) external {
        require(position[tokenId].owner == msg.sender, "owner");
        position[tokenId].approved = operator;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return position[tokenId].approved;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        require(position[tokenId].owner != address(0), "missing");
        return position[tokenId].owner;
    }

    function transferPosition(uint256 tokenId, address recipient) external {
        require(position[tokenId].owner == msg.sender, "owner");
        position[tokenId].owner = recipient;
        position[tokenId].approved = address(0);
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "deadline");
        bool token0Input = params.amount0Desired > 0 && params.amount1Desired == 0;
        bool token1Input = params.amount1Desired > 0 && params.amount0Desired == 0;
        require(token0Input || token1Input, "single side");
        uint256 desired = token0Input ? params.amount0Desired : params.amount1Desired;
        uint256 used = desired - desired / 100;
        address input = token0Input ? params.token0 : params.token1;
        require(LimitOrderMockERC20(input).transferFrom(msg.sender, address(this), used), "pull");
        amount0 = token0Input ? used : 0;
        amount1 = token0Input ? 0 : used;
        liquidity = uint128(used);
        tokenId = nextTokenId++;
        position[tokenId] = Position({
            owner: params.recipient,
            approved: address(0),
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            principal: used,
            owed0: 0,
            owed1: 0,
            feeGrowthInside0LastX128: 0,
            feeGrowthInside1LastX128: 0,
            inputWasToken0: token0Input
        });
    }

    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Position storage current = position[tokenId];
        current.owed0 += amount0;
        current.owed1 += amount1;
        LimitOrderMockERC20(current.token0).mint(address(this), amount0);
        LimitOrderMockERC20(current.token1).mint(address(this), amount1);
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage current = position[params.tokenId];
        require(_approved(current), "approval");
        require(current.liquidity == params.liquidity, "liquidity");
        address poolAddress = factory.getPool(current.token0, current.token1, current.fee);
        int24 tick = LimitOrderMockPool(poolAddress).currentTick();
        uint256 principal = current.principal;
        if (tick >= current.tickUpper) {
            amount1 = principal;
            if (current.inputWasToken0) {
                LimitOrderMockERC20(current.token0).transfer(address(0xdead), principal);
                LimitOrderMockERC20(current.token1).mint(address(this), principal);
            }
        } else if (tick < current.tickLower) {
            amount0 = principal;
            if (!current.inputWasToken0) {
                LimitOrderMockERC20(current.token1).transfer(address(0xdead), principal);
                LimitOrderMockERC20(current.token0).mint(address(this), principal);
            }
        } else {
            amount0 = principal / 2;
            amount1 = principal - amount0;
            if (current.inputWasToken0) {
                LimitOrderMockERC20(current.token0).transfer(address(0xdead), amount1);
                LimitOrderMockERC20(current.token1).mint(address(this), amount1);
            } else {
                LimitOrderMockERC20(current.token1).transfer(address(0xdead), amount0);
                LimitOrderMockERC20(current.token0).mint(address(this), amount0);
            }
        }
        current.owed0 += amount0;
        current.owed1 += amount1;
        current.principal = 0;
        current.liquidity = 0;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage current = position[params.tokenId];
        require(_approved(current), "approval");
        amount0 = current.owed0 > params.amount0Max ? params.amount0Max : current.owed0;
        amount1 = current.owed1 > params.amount1Max ? params.amount1Max : current.owed1;
        current.owed0 -= amount0;
        current.owed1 -= amount1;
        if (amount0 > 0) current.feeGrowthInside0LastX128 += 1;
        if (amount1 > 0) current.feeGrowthInside1LastX128 += 1;
        if (amount0 > 0) LimitOrderMockERC20(current.token0).transfer(params.recipient, amount0);
        if (amount1 > 0) LimitOrderMockERC20(current.token1).transfer(params.recipient, amount1);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address,
            address,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
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
            current.feeGrowthInside0LastX128,
            current.feeGrowthInside1LastX128,
            uint128(current.owed0),
            uint128(current.owed1)
        );
    }

    function _approved(Position storage current) private view returns (bool) {
        return current.owner == msg.sender || current.approved == msg.sender ||
            isApprovedForAll[current.owner][msg.sender];
    }
}
