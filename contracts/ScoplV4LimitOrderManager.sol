// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IV4LimitOrderERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender)
        external
        view
        returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool);
}

interface IV4LimitOrderWETH is IV4LimitOrderERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IV4LimitOrderPermit2 {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;
}

interface IV4LimitOrderStateView {
    function poolManager() external view returns (address);

    function getSlot0(bytes32 poolId)
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint24 protocolFee,
            uint24 lpFee
        );

    function getPositionInfo(
        bytes32 poolId,
        address positionOwner,
        int24 tickLower,
        int24 tickUpper,
        bytes32 salt
    ) external view returns (
        uint128 liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128
    );
}

interface IV4LimitOrderPositionManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function nextTokenId() external view returns (uint256);
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable;
    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory key, uint256 info);
    function getPositionLiquidity(uint256 tokenId)
        external
        view
        returns (uint128 liquidity);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator)
        external
        view
        returns (bool);
}

interface IV4LimitOrderRevenueDistributor {
    function distributeAttributed(
        bytes32 sourceRevenueId,
        address payer,
        address referrer,
        address token,
        uint256 grossAmount
    ) external payable;
}

interface IV4LimitOrderPolicy {
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

/// @notice Creates and settles SCOPL V2 one-tick Uniswap V4 range orders.
/// @dev Position NFTs are minted to users and never held by this contract.
///      Every order becomes unmanageable after its cached fee-growth
///      checkpoint proves that fees were realized through PositionManager.
///      Non-zero hooks require a governance policy for the exact calldata hash.
///      The policy and hook code hash are revalidated before SCOPL execution.
///      Direct Uniswap position management remains the user's escape path.
contract ScoplV4LimitOrderManager {
    error AlreadyFinal();
    error DeadlineExpired();
    error DuplicatePosition();
    error ExecutionPaused();
    error HookDataTooLarge();
    error HookNotAllowed();
    error InsufficientGasReserve();
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
    uint256 public constant MAX_HOOK_DATA_BYTES = 512;
    bool public constant automaticPayouts = true;
    bytes1 private constant V4_DECREASE_LIQUIDITY = 0x01;
    bytes1 private constant V4_INCREASE_LIQUIDITY = 0x00;
    bytes1 private constant V4_MINT_POSITION = 0x02;
    bytes1 private constant V4_SETTLE_PAIR = 0x0d;
    bytes1 private constant V4_TAKE_PAIR = 0x11;
    bytes1 private constant V4_SWEEP = 0x14;

    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled,
        Stale
    }

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct LimitOrder {
        address owner;
        uint256 tokenId;
        address tokenIn;
        address tokenOut;
        bytes32 poolId;
        uint128 initialLiquidity;
        uint128 amountIn;
        uint96 gasReserve;
        uint48 createdAt;
        int24 tickLower;
        int24 tickUpper;
        bool sellToken0;
        OrderStatus status;
    }

    struct CreateOrderParams {
        PoolKey key;
        address tokenIn;
        address tokenOut;
        int24 tickLower;
        int24 tickUpper;
        uint256 amountIn;
        uint256 amountInMinimum;
        uint256 liquidity;
        uint256 gasReserve;
        uint256 deadline;
        bytes hookData;
        bytes32 integrationId;
        address optionalReferrer;
        IV4LimitOrderPolicy.TierAttestation tierAttestation;
        bytes tierSignature;
    }

    struct OrderEconomics {
        IV4LimitOrderPolicy.OrderSource source;
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
        bytes32 poolId,
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
        IV4LimitOrderPolicy.OrderSource source,
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
    event HookPermissionUpdated(address indexed hook, bool allowed);
    event HookPolicyUpdated(
        address indexed hook,
        bool allowed,
        bytes32 hookDataHash,
        bytes32 codeHash
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
    address public immutable positionManager;
    address public immutable stateView;
    address public immutable poolManager;
    address public immutable permit2;
    address public immutable weth;
    uint256 public minGasReserveWei;
    uint256 public nextOrderId = 1;
    bool public paused;
    bool public executionPaused;
    uint256 private reentrancyState = 1;

    mapping(uint256 orderId => LimitOrder order) public orders;
    mapping(uint256 orderId => OrderEconomics economics) public orderEconomics;
    mapping(uint256 orderId => bytes32 snapshot) public orderFeeGrowthSnapshots;
    mapping(uint256 orderId => PoolKey key) public orderPoolKeys;
    mapping(uint256 orderId => bytes hookData) private orderHookData;
    mapping(address orderOwner => uint256[] orderIds) private ownerOrders;
    mapping(uint256 tokenId => uint256 orderId) public orderForTokenId;
    mapping(address orderOwner => uint256 count) public activeOrderCount;
    mapping(address hook => bool allowed) public allowedHooks;
    mapping(address hook => bytes32 hookDataHash) public allowedHookDataHash;
    mapping(address hook => bytes32 codeHash) public allowedHookCodeHash;
    mapping(uint256 orderId => bytes32 codeHash) public orderHookCodeHash;
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
        address v4PositionManager,
        address v4StateView,
        address v4PoolManager,
        address permit2Address,
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
            v4PositionManager.code.length == 0 ||
            v4StateView.code.length == 0 ||
            v4PoolManager.code.length == 0 ||
            permit2Address.code.length == 0 ||
            wrappedNative.code.length == 0 ||
            initialRevenueDistributor.code.length == 0 ||
            initialOrderPolicy.code.length == 0
        ) revert InvalidContract();
        if (
            IV4LimitOrderPositionManager(v4PositionManager).poolManager() !=
                v4PoolManager ||
            IV4LimitOrderPositionManager(v4PositionManager).permit2() !=
                permit2Address ||
            IV4LimitOrderStateView(v4StateView).poolManager() !=
                v4PoolManager
        ) revert InvalidContract();
        if (initialMinGasReserveWei > type(uint96).max) revert InvalidAmount();
        owner = initialOwner;
        revenueDistributor = initialRevenueDistributor;
        orderPolicy = initialOrderPolicy;
        positionManager = v4PositionManager;
        stateView = v4StateView;
        poolManager = v4PoolManager;
        permit2 = permit2Address;
        weth = wrappedNative;
        minGasReserveWei = initialMinGasReserveWei;
        allowedHooks[address(0)] = true;
        allowedHookDataHash[address(0)] = keccak256(bytes(""));
        emit OwnershipTransferred(address(0), initialOwner);
        emit RevenueDistributorUpdated(initialRevenueDistributor);
        emit MinGasReserveUpdated(initialMinGasReserveWei);
        emit HookPermissionUpdated(address(0), true);
    }

    receive() external payable {
        if (
            msg.sender != positionManager &&
            msg.sender != poolManager &&
            msg.sender != weth
        ) revert UnexpectedNativeTransfer();
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
        if (paused) revert Paused();
        if (activeOrderCount[msg.sender] >= MAX_OWNER_ORDERS) {
            revert InvalidAmount();
        }
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            params.gasReserve < minGasReserveWei ||
            params.gasReserve > type(uint96).max
        ) revert InsufficientGasReserve();
        if (
            params.amountIn == 0 ||
            params.amountIn > type(uint128).max ||
            params.amountInMinimum > params.amountIn ||
            params.liquidity == 0 ||
            params.liquidity > type(uint128).max
        ) revert InvalidAmount();
        if (params.hookData.length > MAX_HOOK_DATA_BYTES) {
            revert HookDataTooLarge();
        }
        if (
            !allowedHooks[params.key.hooks] ||
            allowedHookDataHash[params.key.hooks] !=
                keccak256(params.hookData) ||
            (
                params.key.hooks != address(0) &&
                (
                    allowedHookCodeHash[params.key.hooks] == bytes32(0) ||
                    allowedHookCodeHash[params.key.hooks] !=
                        params.key.hooks.codehash
                )
            )
        ) revert HookNotAllowed();
        if (
            !IV4LimitOrderPositionManager(positionManager).isApprovedForAll(
                msg.sender,
                address(this)
            )
        ) revert PositionNotApproved();

        (bytes32 poolId, bool sellToken0) = _validatePoolAndRange(params);
        IV4LimitOrderPolicy.ResolvedOrderPolicy memory resolved =
            IV4LimitOrderPolicy(orderPolicy).resolveOrderPolicy(
                msg.sender,
                params.integrationId,
                params.optionalReferrer,
                params.tierAttestation,
                params.tierSignature
            );
        _requireValidPolicy(resolved, msg.sender);
        bool nativeInput = params.tokenIn == address(0);
        if (msg.value < params.gasReserve) revert InsufficientGasReserve();
        uint256 nativeFunding = msg.value - params.gasReserve;
        if (nativeFunding > params.amountIn) revert InvalidAmount();
        if (
            nativeFunding > 0 &&
            !nativeInput &&
            params.tokenIn != weth
        ) revert InvalidPair();

        uint256 beforeBalance = nativeInput
            ? _balanceOf(params.tokenIn) - msg.value
            : _balanceOf(params.tokenIn);
        uint256 wrappedFunding = params.amountIn - nativeFunding;
        if (nativeInput) {
            if (wrappedFunding > 0) {
                uint256 beforeWeth = _balanceOf(weth);
                _safeTransferFrom(
                    weth,
                    msg.sender,
                    address(this),
                    wrappedFunding
                );
                if (_balanceOf(weth) - beforeWeth != wrappedFunding) {
                    revert TransferFailed();
                }
                IV4LimitOrderWETH(weth).withdraw(wrappedFunding);
            }
        } else {
            if (nativeFunding > 0) {
                IV4LimitOrderWETH(weth).deposit{value: nativeFunding}();
            }
            if (wrappedFunding > 0) {
                _safeTransferFrom(
                    params.tokenIn,
                    msg.sender,
                    address(this),
                    wrappedFunding
                );
            }
            if (_balanceOf(params.tokenIn) - beforeBalance != params.amountIn) {
                revert TransferFailed();
            }
            _permitToken(params.tokenIn, params.amountIn, params.deadline);
        }

        tokenId = IV4LimitOrderPositionManager(positionManager).nextTokenId();
        uint128 amount0Max = sellToken0 ? uint128(params.amountIn) : 0;
        uint128 amount1Max = sellToken0 ? 0 : uint128(params.amountIn);
        _mintPosition(
            params,
            amount0Max,
            amount1Max,
            nativeInput ? params.amountIn : 0
        );
        if (!nativeInput) _revokeToken(params.tokenIn);

        liquidity = IV4LimitOrderPositionManager(positionManager)
            .getPositionLiquidity(tokenId);
        if (liquidity != uint128(params.liquidity)) revert PositionChanged();
        if (
            IV4LimitOrderPositionManager(positionManager).ownerOf(tokenId) !=
            msg.sender
        ) revert PositionChanged();
        if (orderForTokenId[tokenId] != 0) revert DuplicatePosition();
        _requirePositionMatches(tokenId, params.key, params.tickLower, params.tickUpper);

        uint256 expectedBalance = beforeBalance +
            (nativeInput ? params.gasReserve : 0);
        uint256 afterBalance = _balanceOf(params.tokenIn);
        if (afterBalance < expectedBalance) revert TransferFailed();
        uint256 unusedAmount = afterBalance - expectedBalance;
        if (unusedAmount > params.amountIn) revert TransferFailed();
        uint256 usedAmount = params.amountIn - unusedAmount;
        if (usedAmount < params.amountInMinimum || usedAmount == 0) {
            revert InvalidAmount();
        }
        if (unusedAmount > 0) {
            _payout(params.tokenIn, msg.sender, unusedAmount);
        }

        orderId = nextOrderId++;
        orders[orderId] = LimitOrder({
            owner: msg.sender,
            tokenId: tokenId,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            poolId: poolId,
            initialLiquidity: liquidity,
            amountIn: uint128(usedAmount),
            gasReserve: uint96(params.gasReserve),
            createdAt: uint48(block.timestamp),
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            sellToken0: sellToken0,
            status: OrderStatus.Open
        });
        orderPoolKeys[orderId] = params.key;
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
        orderFeeGrowthSnapshots[orderId] = _positionFeeGrowthSnapshot(
            poolId,
            tokenId,
            params.tickLower,
            params.tickUpper
        );
        orderHookData[orderId] = params.hookData;
        orderHookCodeHash[orderId] = params.key.hooks.codehash;
        orderForTokenId[tokenId] = orderId;
        ownerOrders[msg.sender].push(orderId);
        activeOrderCount[msg.sender] += 1;
        emit OrderCreated(
            orderId,
            msg.sender,
            tokenId,
            poolId,
            params.tokenIn,
            params.tokenOut,
            usedAmount,
            params.tickLower,
            params.tickUpper,
            params.gasReserve
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
    }

    function executeOrder(uint256 orderId) external nonReentrant {
        if (executionPaused) revert ExecutionPaused();
        LimitOrder storage order = orders[orderId];
        if (order.status != OrderStatus.Open) revert AlreadyFinal();
        if (!_positionIsManageable(orderId, order)) revert PositionChanged();
        if (!_hookPolicyIsCurrent(orderId)) revert HookNotAllowed();
        if (!_tickCrossed(orderId, order)) revert NotExecutable();

        order.status = OrderStatus.Filled;
        activeOrderCount[order.owner] -= 1;
        uint256 keeperReward = order.gasReserve;
        order.gasReserve = 0;
        (uint256 fee0, uint256 fee1) = _collectPositionFees(orderId, order);
        (uint256 principal0, uint256 principal1) =
            _withdrawPrincipal(orderId, order);
        _settleLpFees(orderId, order, fee0, fee1);
        PoolKey storage key = orderPoolKeys[orderId];
        _payout(key.currency0, order.owner, principal0);
        _payout(key.currency1, order.owner, principal1);
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
        if (!_hookCodeIsCurrent(orderId)) revert HookNotAllowed();
        order.status = OrderStatus.Cancelled;
        activeOrderCount[order.owner] -= 1;
        uint256 reserveRefund = order.gasReserve;
        order.gasReserve = 0;
        (uint256 fee0, uint256 fee1) = _collectPositionFees(orderId, order);
        (uint256 principal0, uint256 principal1) =
            _withdrawPrincipal(orderId, order);
        _settleLpFees(orderId, order, fee0, fee1);
        PoolKey storage key = orderPoolKeys[orderId];
        _payout(key.currency0, order.owner, principal0);
        _payout(key.currency1, order.owner, principal1);
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
            _hookPolicyIsCurrent(orderId) &&
            _tickCrossed(orderId, order);
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

    function getOrderHookData(uint256 orderId)
        external
        view
        returns (bytes memory)
    {
        return orderHookData[orderId];
    }

    function setHookAllowed(address hook, bool allowed) external onlyOwner {
        _setHookPolicy(hook, allowed, keccak256(bytes("")));
    }

    function setHookPolicy(
        address hook,
        bool allowed,
        bytes32 hookDataHash
    ) external onlyOwner {
        _setHookPolicy(hook, allowed, hookDataHash);
    }

    function _setHookPolicy(
        address hook,
        bool allowed,
        bytes32 hookDataHash
    ) private {
        if (hook == address(0) && !allowed) revert HookNotAllowed();
        if (allowed && hook != address(0) && hook.code.length == 0) {
            revert InvalidContract();
        }
        if (allowed && hookDataHash == bytes32(0)) revert HookNotAllowed();
        allowedHooks[hook] = allowed;
        allowedHookDataHash[hook] = allowed ? hookDataHash : bytes32(0);
        allowedHookCodeHash[hook] = allowed && hook != address(0)
            ? hook.codehash
            : bytes32(0);
        emit HookPermissionUpdated(hook, allowed);
        emit HookPolicyUpdated(
            hook,
            allowed,
            allowedHookDataHash[hook],
            allowedHookCodeHash[hook]
        );
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
        returns (bytes32 poolId, bool sellToken0)
    {
        PoolKey calldata key = params.key;
        if (
            key.currency0 >= key.currency1 ||
            key.tickSpacing <= 0 ||
            params.tokenIn == params.tokenOut ||
            (params.tokenIn != key.currency0 && params.tokenIn != key.currency1) ||
            (params.tokenOut != key.currency0 && params.tokenOut != key.currency1)
        ) revert InvalidPair();
        if (
            (key.currency0 != address(0) && key.currency0.code.length == 0) ||
            key.currency1.code.length == 0
        ) revert InvalidContract();
        if (
            params.tickLower % key.tickSpacing != 0 ||
            params.tickUpper % key.tickSpacing != 0 ||
            params.tickUpper - params.tickLower != key.tickSpacing
        ) revert InvalidRange();
        poolId = keccak256(abi.encode(key));
        (uint160 sqrtPriceX96, int24 currentTick, , ) =
            IV4LimitOrderStateView(stateView).getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert InvalidPool();
        sellToken0 = params.tokenIn == key.currency0;
        if (sellToken0) {
            if (currentTick >= params.tickLower) revert InvalidRange();
        } else if (currentTick < params.tickUpper) {
            revert InvalidRange();
        }
    }

    function _mintPosition(
        CreateOrderParams calldata params,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 nativeValue
    ) private {
        bool nativeInput = params.tokenIn == address(0);
        bytes memory actions = nativeInput
            ? abi.encodePacked(
                V4_MINT_POSITION,
                V4_SETTLE_PAIR,
                V4_SWEEP
            )
            : abi.encodePacked(V4_MINT_POSITION, V4_SETTLE_PAIR);
        bytes[] memory actionParams = new bytes[](nativeInput ? 3 : 2);
        actionParams[0] = abi.encode(
            params.key,
            params.tickLower,
            params.tickUpper,
            params.liquidity,
            amount0Max,
            amount1Max,
            msg.sender,
            params.hookData
        );
        actionParams[1] = abi.encode(
            params.key.currency0,
            params.key.currency1
        );
        if (nativeInput) {
            actionParams[2] = abi.encode(address(0), address(this));
        }
        IV4LimitOrderPositionManager(positionManager).modifyLiquidities{
            value: nativeValue
        }(abi.encode(actions, actionParams), params.deadline);
    }

    function _positionIsManageable(
        uint256 orderId,
        LimitOrder storage order
    ) private view returns (bool) {
        try IV4LimitOrderPositionManager(positionManager).ownerOf(order.tokenId)
            returns (address positionOwner)
        {
            if (positionOwner != order.owner) return false;
        } catch {
            return false;
        }
        bool approved = IV4LimitOrderPositionManager(positionManager)
            .isApprovedForAll(order.owner, address(this));
        if (!approved) {
            try IV4LimitOrderPositionManager(positionManager).getApproved(
                order.tokenId
            ) returns (address operator) {
                approved = operator == address(this);
            } catch {
                return false;
            }
        }
        if (!approved) return false;
        try IV4LimitOrderPositionManager(positionManager)
            .getPositionLiquidity(order.tokenId)
            returns (uint128 liquidity)
        {
            if (liquidity != order.initialLiquidity) return false;
        } catch {
            return false;
        }
        try IV4LimitOrderPositionManager(positionManager)
            .getPoolAndPositionInfo(order.tokenId)
            returns (
                IV4LimitOrderPositionManager.PoolKey memory actual,
                uint256 info
            )
        {
            PoolKey storage expected = orderPoolKeys[orderId];
            return _sameKey(expected, actual) &&
                _tickLower(info) == order.tickLower &&
                _tickUpper(info) == order.tickUpper &&
                _feesRemainUnclaimed(orderId, order);
        } catch {
            return false;
        }
    }

    function _feesRemainUnclaimed(
        uint256 orderId,
        LimitOrder storage order
    ) private view returns (bool) {
        return orderFeeGrowthSnapshots[orderId] ==
            _positionFeeGrowthSnapshot(
                order.poolId,
                order.tokenId,
                order.tickLower,
                order.tickUpper
            );
    }

    function _positionFeeGrowthSnapshot(
        bytes32 poolId,
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper
    ) private view returns (bytes32 snapshot) {
        (
            ,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128
        ) = IV4LimitOrderStateView(stateView).getPositionInfo(
            poolId,
            positionManager,
            tickLower,
            tickUpper,
            bytes32(tokenId)
        );
        snapshot = keccak256(
            abi.encode(
                feeGrowthInside0LastX128,
                feeGrowthInside1LastX128
            )
        );
    }

    function _hookPolicyIsCurrent(uint256 orderId)
        private
        view
        returns (bool)
    {
        address hook = orderPoolKeys[orderId].hooks;
        return allowedHooks[hook] &&
            allowedHookDataHash[hook] == keccak256(orderHookData[orderId]) &&
            (
                hook == address(0) ||
                allowedHookCodeHash[hook] == orderHookCodeHash[orderId]
            ) &&
            _hookCodeIsCurrent(orderId);
    }

    /// @dev Revocation blocks new execution but an unchanged hook can still be
    ///      used to cancel. If its runtime code changes, the owner must use the
    ///      official PositionManager interface directly, preserving custody.
    function _hookCodeIsCurrent(uint256 orderId) private view returns (bool) {
        address hook = orderPoolKeys[orderId].hooks;
        return hook == address(0) ||
            (
                orderHookCodeHash[orderId] != bytes32(0) &&
                orderHookCodeHash[orderId] == hook.codehash
            );
    }

    function _tickCrossed(uint256 orderId, LimitOrder storage order)
        private
        view
        returns (bool)
    {
        PoolKey storage key = orderPoolKeys[orderId];
        bytes32 poolId = keccak256(abi.encode(key));
        try IV4LimitOrderStateView(stateView).getSlot0(poolId)
            returns (uint160 sqrtPriceX96, int24 currentTick, uint24, uint24)
        {
            if (sqrtPriceX96 == 0) return false;
            return order.sellToken0
                ? currentTick >= order.tickUpper
                : currentTick < order.tickLower;
        } catch {
            return false;
        }
    }

    function _collectPositionFees(
        uint256 orderId,
        LimitOrder storage order
    ) private returns (uint256 fee0, uint256 fee1) {
        PoolKey storage key = orderPoolKeys[orderId];
        uint256 before0 = _balanceOf(key.currency0);
        uint256 before1 = _balanceOf(key.currency1);
        bytes memory actions =
            abi.encodePacked(V4_INCREASE_LIQUIDITY, V4_TAKE_PAIR);
        bytes[] memory actionParams = new bytes[](2);
        actionParams[0] = abi.encode(
            order.tokenId,
            uint256(0),
            uint128(0),
            uint128(0),
            orderHookData[orderId]
        );
        actionParams[1] = abi.encode(
            key.currency0,
            key.currency1,
            address(this)
        );
        IV4LimitOrderPositionManager(positionManager).modifyLiquidities(
            abi.encode(actions, actionParams),
            block.timestamp
        );
        fee0 = _balanceOf(key.currency0) - before0;
        fee1 = _balanceOf(key.currency1) - before1;
    }

    function _withdrawPrincipal(
        uint256 orderId,
        LimitOrder storage order
    ) private returns (uint256 amount0, uint256 amount1) {
        PoolKey storage key = orderPoolKeys[orderId];
        uint256 before0 = _balanceOf(key.currency0);
        uint256 before1 = _balanceOf(key.currency1);
        bytes memory actions =
            abi.encodePacked(V4_DECREASE_LIQUIDITY, V4_TAKE_PAIR);
        bytes[] memory actionParams = new bytes[](2);
        actionParams[0] = abi.encode(
            order.tokenId,
            uint256(order.initialLiquidity),
            uint128(0),
            uint128(0),
            orderHookData[orderId]
        );
        actionParams[1] = abi.encode(
            key.currency0,
            key.currency1,
            address(this)
        );
        IV4LimitOrderPositionManager(positionManager).modifyLiquidities(
            abi.encode(actions, actionParams),
            block.timestamp
        );
        amount0 = _balanceOf(key.currency0) - before0;
        amount1 = _balanceOf(key.currency1) - before1;
    }

    function _settleLpFees(
        uint256 orderId,
        LimitOrder storage order,
        uint256 fee0,
        uint256 fee1
    ) private {
        PoolKey storage key = orderPoolKeys[orderId];
        _settleFeeAsset(orderId, order, key.currency0, fee0, 1);
        _settleFeeAsset(orderId, order, key.currency1, fee1, 2);
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
            _distributeRevenueAsset(
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

    function _requirePositionMatches(
        uint256 tokenId,
        PoolKey calldata expected,
        int24 tickLower,
        int24 tickUpper
    ) private view {
        (
            IV4LimitOrderPositionManager.PoolKey memory actual,
            uint256 info
        ) = IV4LimitOrderPositionManager(positionManager)
            .getPoolAndPositionInfo(tokenId);
        if (
            actual.currency0 != expected.currency0 ||
            actual.currency1 != expected.currency1 ||
            actual.fee != expected.fee ||
            actual.tickSpacing != expected.tickSpacing ||
            actual.hooks != expected.hooks ||
            _tickLower(info) != tickLower ||
            _tickUpper(info) != tickUpper
        ) revert PositionChanged();
    }

    function _sameKey(
        PoolKey storage expected,
        IV4LimitOrderPositionManager.PoolKey memory actual
    ) private view returns (bool) {
        return expected.currency0 == actual.currency0 &&
            expected.currency1 == actual.currency1 &&
            expected.fee == actual.fee &&
            expected.tickSpacing == actual.tickSpacing &&
            expected.hooks == actual.hooks;
    }

    function _tickLower(uint256 info) private pure returns (int24) {
        return int24(uint24(info >> 8));
    }

    function _tickUpper(uint256 info) private pure returns (int24) {
        return int24(uint24(info >> 32));
    }

    function _distributeRevenueAsset(
        uint256 orderId,
        uint8 revenueType,
        address payer,
        address referrer,
        address token,
        uint256 amount
    ) private {
        address feeAsset = token;
        if (feeAsset == address(0)) {
            IV4LimitOrderWETH(weth).deposit{value: amount}();
            feeAsset = weth;
        }
        _routeRevenue(
            orderId,
            revenueType,
            payer,
            referrer,
            feeAsset,
            amount
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
        uint256 beforeBalance = _balanceOf(token);
        IV4LimitOrderRevenueDistributor(distributor).distributeAttributed(
            keccak256(abi.encode(address(this), orderId, revenueType, token)),
            payer,
            referrer,
            token,
            protocolFee
        );
        _forceApprove(token, distributor, 0);
        if (beforeBalance - _balanceOf(token) != protocolFee) {
            revert TransferFailed();
        }
    }

    function _requireValidPolicy(
        IV4LimitOrderPolicy.ResolvedOrderPolicy memory resolved,
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
                resolved.source == IV4LimitOrderPolicy.OrderSource.Direct &&
                (
                    resolved.integrationId != bytes32(0) ||
                    resolved.beneficiary != orderOwner ||
                    resolved.integratorFeeRecipient != address(0) ||
                    resolved.integratorShareBps != 0
                )
            ) ||
            (
                resolved.source == IV4LimitOrderPolicy.OrderSource.Integration &&
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

    function _permitToken(address token, uint256 amount, uint256 deadline)
        private
    {
        if (amount > type(uint160).max || deadline > type(uint48).max) {
            revert InvalidAmount();
        }
        // Solady-style ERC-20s can give Permit2 an immutable, implicit
        // uint256.max allowance and deliberately reject finite approvals.
        // Standard tokens keep the existing exact, temporary allowance.
        if (_allowanceOf(token, address(this), permit2) < amount) {
            _forceApprove(token, permit2, amount);
        }
        IV4LimitOrderPermit2(permit2).approve(
            token,
            positionManager,
            uint160(amount),
            uint48(deadline)
        );
    }

    function _revokeToken(address token) private {
        IV4LimitOrderPermit2(permit2).approve(token, positionManager, 0, 0);
        if (!_tryApprove(token, permit2, 0)) {
            // Fixed-infinite Permit2 tokens reject zero approvals. Only accept
            // that failure when the token still reports the canonical maximum
            // allowance; every mutable allowance must be cleared.
            if (
                _allowanceOf(token, address(this), permit2) !=
                type(uint256).max
            ) revert TransferFailed();
        }
    }

    function _allowanceOf(address token, address owner_, address spender)
        private
        view
        returns (uint256 allowance_)
    {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeCall(
                IV4LimitOrderERC20.allowance,
                (owner_, spender)
            )
        );
        if (!success || data.length < 32) revert TransferFailed();
        allowance_ = abi.decode(data, (uint256));
    }

    function _balanceOf(address token) private view returns (uint256 balance) {
        if (token == address(0)) return address(this).balance;
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeCall(IV4LimitOrderERC20.balanceOf, (address(this)))
        );
        if (!success || data.length < 32) revert TransferFailed();
        balance = abi.decode(data, (uint256));
    }

    function _payout(address token, address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            _sendNative(recipient, amount);
        } else if (token == weth) {
            if (preferWrappedNative[recipient]) {
                _safeTransfer(weth, recipient, amount);
            } else {
                IV4LimitOrderWETH(weth).withdraw(amount);
                _sendNative(recipient, amount);
            }
        } else {
            _safeTransfer(token, recipient, amount);
        }
    }

    function _sendNative(address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (preferWrappedNative[recipient]) {
            IV4LimitOrderWETH(weth).deposit{value: amount}();
            _safeTransfer(weth, recipient, amount);
            return;
        }
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (success) return;
        IV4LimitOrderWETH(weth).deposit{value: amount}();
        _safeTransfer(weth, recipient, amount);
    }

    function _safeTransfer(address token, address recipient, uint256 amount)
        private
    {
        if (amount == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IV4LimitOrderERC20.transfer, (recipient, amount))
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
                IV4LimitOrderERC20.transferFrom,
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
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0)) revert TransferFailed();
        if (!_tryApprove(token, spender, amount)) revert TransferFailed();
    }

    function _tryApprove(address token, address spender, uint256 amount)
        private
        returns (bool)
    {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IV4LimitOrderERC20.approve, (spender, amount))
        );
        return success && (
            data.length == 0 ||
            (data.length >= 32 && abi.decode(data, (bool)))
        );
    }
}
