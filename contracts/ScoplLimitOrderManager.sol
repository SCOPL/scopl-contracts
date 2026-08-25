// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILimitOrderERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool);
}

interface ILimitOrderWETH is ILimitOrderERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ILimitOrderV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee)
        external
        view
        returns (address pool);
}

interface ILimitOrderV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function tickSpacing() external view returns (int24);
}

interface ILimitOrderPositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

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
        );

    function ownerOf(uint256 tokenId) external view returns (address);
    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator)
        external
        view
        returns (bool);
}

interface ILimitOrderRevenueDistributor {
    function distributeAttributed(
        bytes32 sourceRevenueId,
        address payer,
        address referrer,
        address token,
        uint256 grossAmount
    ) external payable;
}

interface ILimitOrderPolicy {
    enum OrderSource {
        Direct,
        Integration
    }

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

    function resolveOrderPolicy(
        address user,
        bytes32 integrationId,
        address optionalReferrer,
        TierAttestation calldata attestation,
        bytes calldata signature
    ) external returns (ResolvedOrderPolicy memory resolved);
}

/// @notice Non-custodial SCOPL V2 automation for one-tick V3 range orders.
/// @dev The NFT remains user-owned and its approval is revocable. Every order
///      becomes unmanageable after its owner realizes or claims position fees.
///      Direct Uniswap position management is an intentional escape path and
///      makes the corresponding SCOPL order stale.
contract ScoplLimitOrderManager {
    error AlreadyFinal();
    error DeadlineExpired();
    error DuplicatePosition();
    error InsufficientGasReserve();
    error ExecutionPaused();
    error InvalidAmount();
    error InvalidContract();
    error InvalidPair();
    error InvalidPool();
    error InvalidRange();
    error InvalidRecipient();
    error InvalidShare();
    error NotExecutable();
    error NotOrderOwner();
    error NotOwner();
    error NotPendingOwner();
    error Paused();
    error PositionChanged();
    error PositionNotApproved();
    error ReentrantCall();
    error TransferFailed();
    error UnexpectedNativeTransfer();

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MIN_PROTOCOL_SHARE_BPS = 2_500;
    uint16 public constant MAX_BENEFICIARY_SHARE_BPS = 7_500;
    uint16 public constant SCOPL_CONTRACT_VERSION = 2;
    uint256 public constant MAX_OWNER_ORDERS = 1_000;
    uint256 public constant MAX_PAGE_SIZE = 200;
    bool public constant automaticPayouts = true;

    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled,
        Stale
    }

    struct LimitOrder {
        address owner;
        uint256 tokenId;
        address tokenIn;
        address tokenOut;
        address token0;
        address token1;
        uint128 initialLiquidity;
        uint128 amountIn;
        uint96 gasReserve;
        uint48 createdAt;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        bool sellToken0;
        OrderStatus status;
    }

    struct CreateOrderParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amountIn;
        uint256 amountInMinimum;
        uint256 deadline;
        bytes32 integrationId;
        address optionalReferrer;
        ILimitOrderPolicy.TierAttestation tierAttestation;
        bytes tierSignature;
    }

    struct OrderEconomics {
        ILimitOrderPolicy.OrderSource source;
        bytes32 integrationId;
        address beneficiary;
        uint16 beneficiaryShareBps;
        address integratorFeeRecipient;
        uint16 integratorShareBps;
        uint16 protocolShareBps;
        address referrer;
    }

    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        uint256 indexed tokenId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        int24 tickLower,
        int24 tickUpper,
        uint256 gasReserve
    );
    event OrderEconomicsStored(
        uint256 indexed orderId,
        address indexed owner,
        ILimitOrderPolicy.OrderSource source,
        bytes32 indexed integrationId,
        address beneficiary,
        uint16 beneficiaryShareBps,
        address integratorFeeRecipient,
        uint16 integratorShareBps,
        uint16 protocolShareBps,
        address referrer
    );
    event OrderFeeShareSettled(
        uint256 indexed orderId,
        address indexed token,
        address indexed beneficiary,
        address integratorFeeRecipient,
        uint256 generatedFee,
        uint256 beneficiaryAmount,
        uint256 integratorAmount,
        uint256 protocolAmount
    );
    event OrderExecuted(
        uint256 indexed orderId,
        address indexed owner,
        address indexed executor,
        uint256 amountOut,
        uint256 protocolFee,
        uint256 keeperReward,
        uint256 amountToken0,
        uint256 amountToken1
    );
    event OrderCancelled(
        uint256 indexed orderId,
        address indexed owner,
        uint256 amountToken0,
        uint256 amountToken1,
        uint256 reserveRefund
    );
    event OrderMarkedStale(
        uint256 indexed orderId,
        address indexed owner,
        uint256 reserveRefund
    );
    event GasReserveIncreased(
        uint256 indexed orderId,
        uint256 addedAmount,
        uint256 newReserve
    );
    event RevenueDistributorUpdated(address indexed revenueDistributor);
    event MinGasReserveUpdated(uint256 minGasReserveWei);
    event PauseUpdated(bool paused);
    event ExecutionPauseUpdated(bool paused);
    event WrappedNativePreferenceUpdated(
        address indexed recipient,
        bool preferWrappedNative
    );
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    address public owner;
    address public pendingOwner;
    address public revenueDistributor;
    address public immutable orderPolicy;
    address public immutable factory;
    address public immutable positionManager;
    address public immutable weth;
    uint256 public minGasReserveWei;
    uint256 public nextOrderId = 1;
    bool public paused;
    bool public executionPaused;
    uint256 private reentrancyState = 1;

    mapping(uint256 orderId => LimitOrder order) public orders;
    mapping(uint256 orderId => OrderEconomics economics) public orderEconomics;
    mapping(uint256 orderId => bytes32 snapshot) public orderFeeGrowthSnapshots;
    mapping(address orderOwner => uint256[] orderIds) private ownerOrders;
    mapping(uint256 tokenId => uint256 orderId) public orderForTokenId;
    mapping(address orderOwner => uint256 count) public activeOrderCount;
    mapping(address recipient => bool preferred) public preferWrappedNative;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address initialOwner,
        address initialRevenueDistributor,
        address initialOrderPolicy,
        address v3Factory,
        address v3PositionManager,
        address wrappedNative,
        uint256 initialMinGasReserveWei
    ) {
        if (
            initialOwner == address(0) ||
            initialRevenueDistributor == address(0) ||
            initialOrderPolicy == address(0)
        ) {
            revert InvalidRecipient();
        }
        if (
            v3Factory.code.length == 0 ||
            v3PositionManager.code.length == 0 ||
            wrappedNative.code.length == 0 ||
            initialRevenueDistributor.code.length == 0 ||
            initialOrderPolicy.code.length == 0
        ) revert InvalidContract();
        if (
            ILimitOrderPositionManager(v3PositionManager).factory() !=
                v3Factory ||
            ILimitOrderPositionManager(v3PositionManager).WETH9() !=
                wrappedNative
        ) revert InvalidContract();
        if (initialMinGasReserveWei > type(uint96).max) revert InvalidAmount();
        owner = initialOwner;
        revenueDistributor = initialRevenueDistributor;
        orderPolicy = initialOrderPolicy;
        factory = v3Factory;
        positionManager = v3PositionManager;
        weth = wrappedNative;
        minGasReserveWei = initialMinGasReserveWei;
        emit OwnershipTransferred(address(0), initialOwner);
        emit RevenueDistributorUpdated(initialRevenueDistributor);
        emit MinGasReserveUpdated(initialMinGasReserveWei);
    }

    receive() external payable {
        if (msg.sender != weth) revert UnexpectedNativeTransfer();
    }

    fallback() external payable {
        revert UnexpectedNativeTransfer();
    }

    function createOrder(CreateOrderParams calldata params)
        external
        payable
        nonReentrant
        returns (uint256 orderId, uint256 tokenId, uint128 liquidity)
    {
        return _createOrder(params, 0, msg.value);
    }

    /// @notice Creates a WETH-pool order using native ETH, existing WETH, or both.
    /// @dev msg.value is the native funding portion plus the keeper gas reserve.
    function createOrderFromNative(
        CreateOrderParams calldata params,
        uint256 gasReserveWei
    )
        external
        payable
        nonReentrant
        returns (uint256 orderId, uint256 tokenId, uint128 liquidity)
    {
        if (msg.value < gasReserveWei) revert InsufficientGasReserve();
        return _createOrder(
            params,
            msg.value - gasReserveWei,
            gasReserveWei
        );
    }

    function _createOrder(
        CreateOrderParams calldata params,
        uint256 nativeWethAmount,
        uint256 gasReserve
    ) private returns (uint256 orderId, uint256 tokenId, uint128 liquidity) {
        if (paused) revert Paused();
        if (activeOrderCount[msg.sender] >= MAX_OWNER_ORDERS) {
            revert InvalidAmount();
        }
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            gasReserve < minGasReserveWei ||
            gasReserve > type(uint96).max
        ) {
            revert InsufficientGasReserve();
        }
        if (
            params.amountIn == 0 ||
            params.amountIn > type(uint128).max ||
            params.amountInMinimum > params.amountIn
        ) revert InvalidAmount();
        if (
            params.tokenIn == address(0) ||
            params.tokenOut == address(0) ||
            params.tokenIn == params.tokenOut
        ) revert InvalidPair();
        if (nativeWethAmount > params.amountIn) revert InvalidAmount();
        if (nativeWethAmount > 0 && params.tokenIn != weth) {
            revert InvalidPair();
        }
        if (
            !ILimitOrderPositionManager(positionManager).isApprovedForAll(
                msg.sender,
                address(this)
            )
        ) revert PositionNotApproved();

        (
            address token0,
            address token1,
            bool sellToken0,
            address pool,
            int24 currentTick
        ) = _validatePoolAndRange(params);
        ILimitOrderPolicy.ResolvedOrderPolicy memory resolved =
            ILimitOrderPolicy(orderPolicy).resolveOrderPolicy(
                msg.sender,
                params.integrationId,
                params.optionalReferrer,
                params.tierAttestation,
                params.tierSignature
            );
        _requireValidPolicy(resolved, msg.sender);

        uint256 beforeBalance = _balanceOf(params.tokenIn, address(this));
        if (nativeWethAmount > 0) {
            ILimitOrderWETH(weth).deposit{value: nativeWethAmount}();
        }
        uint256 wrappedAmount = params.amountIn - nativeWethAmount;
        if (wrappedAmount > 0) {
            _safeTransferFrom(
                params.tokenIn,
                msg.sender,
                address(this),
                wrappedAmount
            );
        }
        if (
            _balanceOf(params.tokenIn, address(this)) - beforeBalance !=
            params.amountIn
        ) revert TransferFailed();
        _forceApprove(params.tokenIn, positionManager, params.amountIn);

        uint256 amount0Desired = sellToken0 ? params.amountIn : 0;
        uint256 amount1Desired = sellToken0 ? 0 : params.amountIn;
        uint256 amount0Minimum = sellToken0 ? params.amountInMinimum : 0;
        uint256 amount1Minimum = sellToken0 ? 0 : params.amountInMinimum;
        uint256 amount0;
        uint256 amount1;
        (tokenId, liquidity, amount0, amount1) =
            ILimitOrderPositionManager(positionManager).mint(
                ILimitOrderPositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: params.fee,
                    tickLower: params.tickLower,
                    tickUpper: params.tickUpper,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Minimum,
                    amount1Min: amount1Minimum,
                    recipient: msg.sender,
                    deadline: params.deadline
                })
            );
        _forceApprove(params.tokenIn, positionManager, 0);
        if (liquidity == 0) revert InvalidAmount();
        if (
            ILimitOrderPositionManager(positionManager).ownerOf(tokenId) !=
            msg.sender
        ) revert PositionChanged();
        if (orderForTokenId[tokenId] != 0) revert DuplicatePosition();

        uint256 usedAmount = sellToken0 ? amount0 : amount1;
        if (usedAmount < params.amountIn) {
            uint256 refund = params.amountIn - usedAmount;
            if (params.tokenIn == weth) {
                ILimitOrderWETH(weth).withdraw(refund);
                _sendNative(msg.sender, refund);
            } else {
                _safeTransfer(params.tokenIn, msg.sender, refund);
            }
        }

        orderId = nextOrderId++;
        orders[orderId] = LimitOrder({
            owner: msg.sender,
            tokenId: tokenId,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            token0: token0,
            token1: token1,
            initialLiquidity: liquidity,
            amountIn: uint128(usedAmount),
            gasReserve: uint96(gasReserve),
            createdAt: uint48(block.timestamp),
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            sellToken0: sellToken0,
            status: OrderStatus.Open
        });
        orderForTokenId[tokenId] = orderId;
        orderEconomics[orderId] = OrderEconomics({
            source: resolved.source,
            integrationId: resolved.integrationId,
            beneficiary: resolved.beneficiary,
            beneficiaryShareBps: resolved.beneficiaryShareBps,
            integratorFeeRecipient: resolved.integratorFeeRecipient,
            integratorShareBps: resolved.integratorShareBps,
            protocolShareBps: resolved.protocolShareBps,
            referrer: resolved.referrer
        });
        orderFeeGrowthSnapshots[orderId] = _positionFeeGrowthSnapshot(tokenId);
        ownerOrders[msg.sender].push(orderId);
        activeOrderCount[msg.sender] += 1;
        emit OrderCreated(
            orderId,
            msg.sender,
            tokenId,
            params.tokenIn,
            params.tokenOut,
            usedAmount,
            params.tickLower,
            params.tickUpper,
            gasReserve
        );
        emit OrderEconomicsStored(
            orderId,
            msg.sender,
            resolved.source,
            resolved.integrationId,
            resolved.beneficiary,
            resolved.beneficiaryShareBps,
            resolved.integratorFeeRecipient,
            resolved.integratorShareBps,
            resolved.protocolShareBps,
            resolved.referrer
        );
        pool;
        currentTick;
    }

    function executeOrder(uint256 orderId) external nonReentrant {
        if (executionPaused) revert ExecutionPaused();
        LimitOrder storage order = orders[orderId];
        if (order.status != OrderStatus.Open) revert AlreadyFinal();
        if (!_positionIsManageable(orderId, order)) revert PositionChanged();
        if (!_tickCrossed(order)) revert NotExecutable();

        order.status = OrderStatus.Filled;
        activeOrderCount[order.owner] -= 1;
        uint256 keeperReward = order.gasReserve;
        order.gasReserve = 0;
        (uint256 fee0, uint256 fee1) = _collectPositionFees(order);
        (uint256 principal0, uint256 principal1) = _withdrawPrincipal(order);
        _settleLpFees(orderId, order, fee0, fee1);
        _payout(order.token0, order.owner, principal0);
        _payout(order.token1, order.owner, principal1);
        _sendNative(msg.sender, keeperReward);

        emit OrderExecuted(
            orderId,
            order.owner,
            msg.sender,
            order.sellToken0 ? principal1 : principal0,
            0,
            keeperReward,
            principal0 + fee0,
            principal1 + fee1
        );
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        LimitOrder storage order = orders[orderId];
        if (order.status != OrderStatus.Open) revert AlreadyFinal();
        if (msg.sender != order.owner) revert NotOrderOwner();
        if (!_positionIsManageable(orderId, order)) revert PositionChanged();
        order.status = OrderStatus.Cancelled;
        activeOrderCount[order.owner] -= 1;
        uint256 reserveRefund = order.gasReserve;
        order.gasReserve = 0;
        (uint256 fee0, uint256 fee1) = _collectPositionFees(order);
        (uint256 principal0, uint256 principal1) = _withdrawPrincipal(order);
        _settleLpFees(orderId, order, fee0, fee1);
        _payout(order.token0, order.owner, principal0);
        _payout(order.token1, order.owner, principal1);
        _sendNative(order.owner, reserveRefund);
        emit OrderCancelled(
            orderId,
            order.owner,
            principal0,
            principal1,
            reserveRefund
        );
    }

    function markOrderStale(uint256 orderId) external nonReentrant {
        LimitOrder storage order = orders[orderId];
        if (order.status != OrderStatus.Open) revert AlreadyFinal();
        if (_positionIsManageable(orderId, order)) revert PositionChanged();
        order.status = OrderStatus.Stale;
        activeOrderCount[order.owner] -= 1;
        uint256 reserveRefund = order.gasReserve;
        order.gasReserve = 0;
        _sendNative(order.owner, reserveRefund);
        emit OrderMarkedStale(orderId, order.owner, reserveRefund);
    }

    function increaseGasReserve(uint256 orderId) external payable {
        LimitOrder storage order = orders[orderId];
        if (order.status != OrderStatus.Open) revert AlreadyFinal();
        if (msg.sender != order.owner) revert NotOrderOwner();
        if (msg.value == 0) revert InvalidAmount();
        uint256 nextReserve = uint256(order.gasReserve) + msg.value;
        if (nextReserve > type(uint96).max) revert InvalidAmount();
        order.gasReserve = uint96(nextReserve);
        emit GasReserveIncreased(orderId, msg.value, nextReserve);
    }

    /// @notice Chooses WETH instead of native ETH for this recipient's future
    ///         proceeds, fee shares, keeper rewards, and reserve refunds.
    function setPreferWrappedNative(bool preferred) external {
        preferWrappedNative[msg.sender] = preferred;
        emit WrappedNativePreferenceUpdated(msg.sender, preferred);
    }

    function isExecutable(uint256 orderId) public view returns (bool) {
        LimitOrder storage order = orders[orderId];
        return !executionPaused && order.status == OrderStatus.Open &&
            _positionIsManageable(orderId, order) &&
            _tickCrossed(order);
    }

    function isPositionManageable(uint256 orderId)
        external
        view
        returns (bool)
    {
        LimitOrder storage order = orders[orderId];
        return order.status == OrderStatus.Open &&
            _positionIsManageable(orderId, order);
    }

    /// @dev Compatibility view for small histories. Indexers and applications
    ///      must use getOrdersByOwnerPage to keep response size bounded.
    function getOrdersByOwner(address orderOwner)
        external
        view
        returns (uint256[] memory)
    {
        return ownerOrders[orderOwner];
    }

    function getOrderCountByOwner(address orderOwner)
        external
        view
        returns (uint256)
    {
        return ownerOrders[orderOwner].length;
    }

    function getOrdersByOwnerPage(
        address orderOwner,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory page) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidAmount();
        uint256 length = ownerOrders[orderOwner].length;
        if (offset >= length) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > length) end = length;
        page = new uint256[](end - offset);
        for (uint256 index = offset; index < end; index++) {
            page[index - offset] = ownerOrders[orderOwner][index];
        }
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidRecipient();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function setRevenueDistributor(address nextDistributor)
        external
        onlyOwner
    {
        if (nextDistributor.code.length == 0) revert InvalidContract();
        revenueDistributor = nextDistributor;
        emit RevenueDistributorUpdated(nextDistributor);
    }

    function setMinGasReserveWei(uint256 nextMinimum) external onlyOwner {
        if (nextMinimum > type(uint96).max) revert InvalidAmount();
        minGasReserveWei = nextMinimum;
        emit MinGasReserveUpdated(nextMinimum);
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseUpdated(nextPaused);
    }

    function setExecutionPaused(bool nextPaused) external onlyOwner {
        executionPaused = nextPaused;
        emit ExecutionPauseUpdated(nextPaused);
    }

    function _validatePoolAndRange(CreateOrderParams calldata params)
        private
        view
        returns (
            address token0,
            address token1,
            bool sellToken0,
            address pool,
            int24 currentTick
        )
    {
        (token0, token1) = params.tokenIn < params.tokenOut
            ? (params.tokenIn, params.tokenOut)
            : (params.tokenOut, params.tokenIn);
        sellToken0 = params.tokenIn == token0;
        pool = ILimitOrderV3Factory(factory).getPool(
            token0,
            token1,
            params.fee
        );
        if (pool == address(0) || pool.code.length == 0) revert InvalidPool();
        int24 spacing = ILimitOrderV3Pool(pool).tickSpacing();
        if (
            spacing <= 0 ||
            params.tickLower % spacing != 0 ||
            params.tickUpper % spacing != 0 ||
            params.tickUpper - params.tickLower != spacing
        ) revert InvalidRange();
        (, currentTick, , , , , ) = ILimitOrderV3Pool(pool).slot0();
        if (sellToken0) {
            if (currentTick >= params.tickLower) revert InvalidRange();
        } else if (currentTick < params.tickUpper) {
            revert InvalidRange();
        }
    }

    function _positionIsManageable(
        uint256 orderId,
        LimitOrder storage order
    )
        private
        view
        returns (bool)
    {
        try ILimitOrderPositionManager(positionManager).ownerOf(order.tokenId)
            returns (address positionOwner)
        {
            if (positionOwner != order.owner) return false;
        } catch {
            return false;
        }
        bool approved = ILimitOrderPositionManager(positionManager)
            .isApprovedForAll(order.owner, address(this));
        if (!approved) {
            try ILimitOrderPositionManager(positionManager).getApproved(
                order.tokenId
            ) returns (address operator) {
                approved = operator == address(this);
            } catch {
                return false;
            }
        }
        if (!approved) return false;
        try ILimitOrderPositionManager(positionManager).positions(order.tokenId)
            returns (
                uint96,
                address,
                address token0,
                address token1,
                uint24 fee,
                int24 tickLower,
                int24 tickUpper,
                uint128 liquidity,
                uint256 feeGrowthInside0LastX128,
                uint256 feeGrowthInside1LastX128,
                uint128,
                uint128
            )
        {
            bool feesRemainUnclaimed =
                orderFeeGrowthSnapshots[orderId] == keccak256(
                    abi.encode(
                        feeGrowthInside0LastX128,
                        feeGrowthInside1LastX128
                    )
                );
            return liquidity == order.initialLiquidity && token0 == order.token0 &&
                token1 == order.token1 &&
                fee == order.fee && tickLower == order.tickLower &&
                tickUpper == order.tickUpper && feesRemainUnclaimed;
        } catch {
            return false;
        }
    }

    function _positionFeeGrowthSnapshot(uint256 tokenId)
        private
        view
        returns (bytes32 snapshot)
    {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            ,

        ) = ILimitOrderPositionManager(positionManager).positions(tokenId);
        snapshot = keccak256(
            abi.encode(
                feeGrowthInside0LastX128,
                feeGrowthInside1LastX128
            )
        );
    }

    function _tickCrossed(LimitOrder storage order)
        private
        view
        returns (bool)
    {
        address pool = ILimitOrderV3Factory(factory).getPool(
            order.token0,
            order.token1,
            order.fee
        );
        if (pool == address(0)) return false;
        (, int24 currentTick, , , , , ) = ILimitOrderV3Pool(pool).slot0();
        return order.sellToken0
            ? currentTick >= order.tickUpper
            : currentTick < order.tickLower;
    }

    function _collectPositionFees(LimitOrder storage order)
        private
        returns (uint256 fee0, uint256 fee1)
    {
        uint256 before0 = _balanceOf(order.token0, address(this));
        uint256 before1 = _balanceOf(order.token1, address(this));
        ILimitOrderPositionManager(positionManager).collect(
            ILimitOrderPositionManager.CollectParams({
                tokenId: order.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        fee0 = _balanceOf(order.token0, address(this)) - before0;
        fee1 = _balanceOf(order.token1, address(this)) - before1;
    }

    function _withdrawPrincipal(LimitOrder storage order)
        private
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 before0 = _balanceOf(order.token0, address(this));
        uint256 before1 = _balanceOf(order.token1, address(this));
        ILimitOrderPositionManager(positionManager).decreaseLiquidity(
            ILimitOrderPositionManager.DecreaseLiquidityParams({
                tokenId: order.tokenId,
                liquidity: order.initialLiquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        ILimitOrderPositionManager(positionManager).collect(
            ILimitOrderPositionManager.CollectParams({
                tokenId: order.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        amount0 = _balanceOf(order.token0, address(this)) - before0;
        amount1 = _balanceOf(order.token1, address(this)) - before1;
    }

    function _settleLpFees(
        uint256 orderId,
        LimitOrder storage order,
        uint256 fee0,
        uint256 fee1
    ) private {
        _settleFeeAsset(orderId, order, order.token0, fee0, 1);
        _settleFeeAsset(orderId, order, order.token1, fee1, 2);
    }

    function _settleFeeAsset(
        uint256 orderId,
        LimitOrder storage order,
        address token,
        uint256 generatedFee,
        uint8 revenueType
    ) private {
        if (generatedFee == 0) return;
        OrderEconomics storage economics = orderEconomics[orderId];
        uint256 beneficiaryAmount =
            generatedFee * economics.beneficiaryShareBps / BPS_DENOMINATOR;
        uint256 integratorAmount =
            generatedFee * economics.integratorShareBps / BPS_DENOMINATOR;
        uint256 protocolAmount =
            generatedFee - beneficiaryAmount - integratorAmount;
        _payout(token, economics.beneficiary, beneficiaryAmount);
        _payout(
            token,
            economics.integratorFeeRecipient,
            integratorAmount
        );
        if (protocolAmount > 0) {
            _routeRevenue(
                orderId,
                revenueType,
                order.owner,
                economics.referrer,
                token,
                protocolAmount
            );
        }
        emit OrderFeeShareSettled(
            orderId,
            token,
            economics.beneficiary,
            economics.integratorFeeRecipient,
            generatedFee,
            beneficiaryAmount,
            integratorAmount,
            protocolAmount
        );
    }

    function _routeRevenue(
        uint256 orderId,
        uint8 revenueType,
        address payer,
        address referrer,
        address token,
        uint256 protocolFee
    ) private {
        address distributor = revenueDistributor;
        _forceApprove(token, distributor, protocolFee);
        uint256 beforeBalance = _balanceOf(token, address(this));
        ILimitOrderRevenueDistributor(distributor).distributeAttributed(
            keccak256(abi.encode(address(this), orderId, revenueType, token)),
            payer,
            referrer,
            token,
            protocolFee
        );
        _forceApprove(token, distributor, 0);
        if (
            beforeBalance - _balanceOf(token, address(this)) != protocolFee
        ) revert TransferFailed();
    }

    function _requireValidPolicy(
        ILimitOrderPolicy.ResolvedOrderPolicy memory resolved,
        address orderOwner
    ) private pure {
        if (
            resolved.beneficiary == address(0) ||
            resolved.beneficiaryShareBps > MAX_BENEFICIARY_SHARE_BPS ||
            resolved.protocolShareBps < MIN_PROTOCOL_SHARE_BPS ||
            uint256(resolved.beneficiaryShareBps) +
                resolved.integratorShareBps +
                resolved.protocolShareBps != BPS_DENOMINATOR ||
            (
                resolved.source == ILimitOrderPolicy.OrderSource.Direct &&
                (
                    resolved.integrationId != bytes32(0) ||
                    resolved.beneficiary != orderOwner ||
                    resolved.integratorFeeRecipient != address(0) ||
                    resolved.integratorShareBps != 0
                )
            ) ||
            (
                resolved.source == ILimitOrderPolicy.OrderSource.Integration &&
                (
                    resolved.integrationId == bytes32(0) ||
                    resolved.beneficiary != orderOwner ||
                    resolved.integratorFeeRecipient == address(0) ||
                    resolved.protocolShareBps != MIN_PROTOCOL_SHARE_BPS ||
                    uint256(resolved.beneficiaryShareBps) +
                        resolved.integratorShareBps != 7_500 ||
                    resolved.referrer != address(0)
                )
            )
        ) revert InvalidShare();
    }

    function _balanceOf(address token, address account)
        private
        view
        returns (uint256 balance)
    {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeCall(ILimitOrderERC20.balanceOf, (account))
        );
        if (!success || data.length < 32) revert TransferFailed();
        balance = abi.decode(data, (uint256));
    }

    function _payout(address token, address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (token == weth) {
            if (preferWrappedNative[recipient]) {
                _safeTransfer(weth, recipient, amount);
            } else {
                ILimitOrderWETH(weth).withdraw(amount);
                _sendNative(recipient, amount);
            }
        } else {
            _safeTransfer(token, recipient, amount);
        }
    }

    function _sendNative(address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (preferWrappedNative[recipient]) {
            ILimitOrderWETH(weth).deposit{value: amount}();
            _safeTransfer(weth, recipient, amount);
            return;
        }
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (success) return;
        ILimitOrderWETH(weth).deposit{value: amount}();
        _safeTransfer(weth, recipient, amount);
    }

    function _safeTransfer(address token, address recipient, uint256 amount)
        private
    {
        if (amount == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(ILimitOrderERC20.transfer, (recipient, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(
        address token,
        address sender,
        address recipient,
        uint256 amount
    ) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(
                ILimitOrderERC20.transferFrom,
                (sender, recipient, amount)
            )
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _forceApprove(address token, address spender, uint256 amount)
        private
    {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(ILimitOrderERC20.approve, (spender, amount))
        );
        if (success && (data.length == 0 || abi.decode(data, (bool)))) return;
        (success, data) = token.call(
            abi.encodeCall(ILimitOrderERC20.approve, (spender, 0))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
        (success, data) = token.call(
            abi.encodeCall(ILimitOrderERC20.approve, (spender, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
