// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZapERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IZapWETH is IZapERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IZapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IZapV3PositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );
}

interface IZapV4PositionManager {
    function nextTokenId() external view returns (uint256);
    function poolManager() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable;
}

interface IZapV4StateView {
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
}

interface IZapUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
        external
        payable;
}

interface IZapPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration)
        external;
}

/// @dev Full-precision multiplication and division derived from Uniswap V3's
///      MIT-licensed FullMath library.
library ZapFullMath {
    function mulDiv(uint256 a, uint256 b, uint256 denominator)
        internal
        pure
        returns (uint256 result)
    {
        unchecked {
            uint256 product0;
            uint256 product1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                product0 := mul(a, b)
                product1 := sub(sub(mm, product0), lt(mm, product0))
            }
            if (product1 == 0) return product0 / denominator;
            require(denominator > product1);

            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, denominator)
                product1 := sub(product1, gt(remainder, product0))
                product0 := sub(product0, remainder)
            }
            uint256 twos = denominator & (0 - denominator);
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                product0 := div(product0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            product0 |= product1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = product0 * inverse;
        }
    }
}

/// @dev Tick-to-price calculation derived from Uniswap V4's MIT-licensed
///      TickMath library. Only the direction needed by this router is kept.
library ZapTickMath {
    int24 internal constant MAX_TICK = 887272;

    function getSqrtPriceAtTick(int24 tick)
        internal
        pure
        returns (uint160 sqrtPriceX96)
    {
        unchecked {
            uint256 absTick = tick < 0
                ? uint256(-int256(tick))
                : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)));
            uint256 price = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) price = (price * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) price = (price * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) price = (price * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) price = (price * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) price = (price * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) price = (price * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) price = (price * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) price = (price * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) price = (price * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) price = (price * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) price = (price * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) price = type(uint256).max / price;
            sqrtPriceX96 = uint160((price >> 32) + (price & type(uint32).max == 0 ? 0 : 1));
        }
    }
}

contract ScoplZapRouter {
    error DeadlineExpired();
    error InvalidAmount();
    error InvalidContract();
    error InvalidPool();
    error InvalidPriceBounds();
    error InvalidSqrtPriceBounds();
    error InvalidPreparationRoute();
    error InvalidRecipient();
    error NotOwner();
    error NotPendingOwner();
    error ReentrantCall();
    error TransferFailed();
    error MinimumLiquidityNotMet(uint256 available, uint256 minimum);
    error SqrtPriceOutOfBounds(
        uint160 sqrtPriceX96,
        uint160 minimumSqrtPriceX96,
        uint160 maximumSqrtPriceX96
    );

    event PositionZapped(
        uint8 indexed version,
        address indexed owner,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 swapAmountIn,
        uint256 tokenId
    );
    event V4PositionMinted(
        address indexed owner,
        uint256 indexed tokenId,
        uint256 liquidity,
        uint256 minimumLiquidity,
        uint256 amount0Budget,
        uint256 amount1Budget
    );
    event AssetRecovered(address indexed token, address indexed recipient, uint256 amount);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct V3ZapParams {
        address token0;
        address token1;
        address sourceToken;
        bytes preparationPath;
        uint256 preparationAmountOutMinimum;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint256 amountIn;
        uint256 swapAmountIn;
        uint256 amountOutMinimum;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct V4SwapParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct V4ZapParams {
        PoolKey key;
        address sourceToken;
        bytes preparationPath;
        uint128 preparationAmountOutMinimum;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint128 amountIn;
        uint128 swapAmountIn;
        uint128 amountOutMinimum;
        uint256 minimumLiquidity;
        uint160 minimumSqrtPriceX96;
        uint160 maximumSqrtPriceX96;
        uint256 deadline;
        bytes hookData;
    }

    struct V4MintParams {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 amount0Max;
        uint128 amount1Max;
        uint256 minimumLiquidity;
        uint160 minimumSqrtPriceX96;
        uint160 maximumSqrtPriceX96;
        bool useNativeForWeth;
        uint256 deadline;
        bytes hookData;
    }

    IZapV3SwapRouter public immutable v3SwapRouter;
    IZapV3PositionManager public immutable v3PositionManager;
    IZapV4PositionManager public immutable v4PositionManager;
    IZapV4StateView public immutable v4StateView;
    IZapUniversalRouter public immutable universalRouter;
    IZapPermit2 public immutable permit2;
    IZapWETH public immutable weth;
    address public owner;
    address public pendingOwner;

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address initialOwner,
        address v3SwapRouterAddress,
        address v3PositionManagerAddress,
        address v4PositionManagerAddress,
        address v4StateViewAddress,
        address universalRouterAddress,
        address permit2Address,
        address wethAddress
    ) {
        if (
            initialOwner == address(0) ||
            v3SwapRouterAddress.code.length == 0 ||
            v3PositionManagerAddress.code.length == 0 ||
            v4PositionManagerAddress.code.length == 0 ||
            v4StateViewAddress.code.length == 0 ||
            universalRouterAddress.code.length == 0 ||
            permit2Address.code.length == 0 ||
            wethAddress.code.length == 0
        ) revert InvalidContract();
        owner = initialOwner;
        v3SwapRouter = IZapV3SwapRouter(v3SwapRouterAddress);
        v3PositionManager = IZapV3PositionManager(v3PositionManagerAddress);
        v4PositionManager = IZapV4PositionManager(v4PositionManagerAddress);
        v4StateView = IZapV4StateView(v4StateViewAddress);
        universalRouter = IZapUniversalRouter(universalRouterAddress);
        permit2 = IZapPermit2(permit2Address);
        weth = IZapWETH(wethAddress);
        if (
            IZapV4PositionManager(v4PositionManagerAddress).poolManager() !=
                IZapV4StateView(v4StateViewAddress).poolManager()
        ) revert InvalidContract();
        emit OwnershipTransferred(address(0), initialOwner);
    }

    receive() external payable {
        if (
            msg.sender != address(weth) &&
            msg.sender != address(universalRouter) &&
            msg.sender != address(v4PositionManager)
        ) revert TransferFailed();
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

    /// @notice Recovers only balances left between transactions. User funds are
    ///         consumed or refunded atomically inside the non-reentrant zap.
    function recoverAsset(address token, address recipient, uint256 amount)
        external onlyOwner nonReentrant
    {
        if (
            recipient == address(0) ||
            (token != address(0) && token.code.length == 0)
        ) {
            revert InvalidRecipient();
        }
        _payout(token, recipient, amount);
        emit AssetRecovered(token, recipient, amount);
    }

    function zapV3(V3ZapParams calldata params)
        external
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity)
    {
        _validateV3(params.token0, params.token1, params.sourceToken, params.amountIn, params.deadline);
        address tokenIn = params.zeroForOne ? params.token0 : params.token1;
        address tokenOut = params.zeroForOne ? params.token1 : params.token0;
        uint256 before0 = IZapERC20(params.token0).balanceOf(address(this));
        uint256 before1 = IZapERC20(params.token1).balanceOf(address(this));
        _safeTransferFrom(params.sourceToken, msg.sender, address(this), params.amountIn);
        uint256 preparedAmount = _prepareInput(
            params.sourceToken,
            tokenIn,
            params.preparationPath,
            params.amountIn,
            params.preparationAmountOutMinimum
        );
        if (params.swapAmountIn > preparedAmount || IZapERC20(tokenIn).balanceOf(address(this)) <
            (params.zeroForOne ? before0 : before1) + preparedAmount) {
            revert InvalidAmount();
        }
        if (params.swapAmountIn > 0) {
            _forceApprove(tokenIn, address(v3SwapRouter), params.swapAmountIn);
            v3SwapRouter.exactInputSingle(IZapV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: params.fee,
                recipient: address(this),
                amountIn: params.swapAmountIn,
                amountOutMinimum: params.amountOutMinimum,
                sqrtPriceLimitX96: 0
            }));
            _forceApprove(tokenIn, address(v3SwapRouter), 0);
        }
        (uint256 amount0Desired, uint256 amount1Desired) =
            _contribution(params.token0, params.token1, before0, before1);
        _forceApprove(params.token0, address(v3PositionManager), amount0Desired);
        _forceApprove(params.token1, address(v3PositionManager), amount1Desired);
        (tokenId, liquidity,,) = v3PositionManager.mint(
            IZapV3PositionManager.MintParams({
                token0: params.token0,
                token1: params.token1,
                fee: params.fee,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: msg.sender,
                deadline: params.deadline
            })
        );
        _forceApprove(params.token0, address(v3PositionManager), 0);
        _forceApprove(params.token1, address(v3PositionManager), 0);
        _refund(params.token0, params.token1, before0, before1, msg.sender);
        emit PositionZapped(3, msg.sender, params.sourceToken, params.amountIn, params.swapAmountIn, tokenId);
    }

    function zapV4(V4ZapParams calldata params)
        external
        payable
        nonReentrant
    {
        address tokenIn = params.zeroForOne ? params.key.currency0 : params.key.currency1;
        _validateV4(
            params.key.currency0,
            params.key.currency1,
            params.sourceToken,
            params.amountIn,
            params.deadline
        );
        uint256 beforeNative = address(this).balance - msg.value;
        uint256 before0 = params.key.currency0 == address(0)
            ? beforeNative
            : _balanceOf(params.key.currency0);
        uint256 before1 = params.key.currency1 == address(0)
            ? beforeNative
            : _balanceOf(params.key.currency1);
        bool nativeSource = params.sourceToken == address(0);
        uint256 preparedAmount;
        if (nativeSource) {
            if (
                tokenIn != address(0) ||
                params.preparationPath.length != 0 ||
                params.preparationAmountOutMinimum != 0
            ) revert InvalidPreparationRoute();
            if (msg.value != params.amountIn) revert InvalidAmount();
            preparedAmount = params.amountIn;
        } else {
            if (msg.value != 0) revert InvalidAmount();
            _safeTransferFrom(
                params.sourceToken,
                msg.sender,
                address(this),
                params.amountIn
            );
            address preparedToken = tokenIn == address(0)
                ? address(weth)
                : tokenIn;
            preparedAmount = _prepareInput(
                params.sourceToken,
                preparedToken,
                params.preparationPath,
                params.amountIn,
                params.preparationAmountOutMinimum
            );
            if (tokenIn == address(0)) weth.withdraw(preparedAmount);
        }
        if (
            params.swapAmountIn > preparedAmount ||
            _balanceOf(tokenIn) <
                (params.zeroForOne ? before0 : before1) + preparedAmount
        ) revert InvalidAmount();
        if (params.swapAmountIn > 0) {
            bool nativeInput = tokenIn == address(0);
            if (!nativeInput) {
                _permit(tokenIn, address(universalRouter), params.swapAmountIn, params.deadline);
            }
            bytes memory actions;
            if (nativeInput) actions = hex"060c0f";
            else actions = hex"060b0f";
            bytes[] memory actionParams = new bytes[](3);
            actionParams[0] = abi.encode(V4SwapParams({
                poolKey: params.key,
                zeroForOne: params.zeroForOne,
                amountIn: params.swapAmountIn,
                amountOutMinimum: params.amountOutMinimum,
                minHopPriceX36: 0,
                hookData: params.hookData
            }));
            actionParams[1] = nativeInput
                ? abi.encode(tokenIn, params.swapAmountIn)
                : abi.encode(tokenIn, params.swapAmountIn, true);
            address tokenOut = params.zeroForOne ? params.key.currency1 : params.key.currency0;
            actionParams[2] = abi.encode(tokenOut, params.amountOutMinimum);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(actions, actionParams);
            universalRouter.execute{value: nativeInput ? params.swapAmountIn : 0}(
                hex"10",
                inputs,
                params.deadline
            );
            if (!nativeInput) _revokePermit(tokenIn, address(universalRouter));
        }

        (uint256 available0, uint256 available1) = _contribution(
            params.key.currency0,
            params.key.currency1,
            before0,
            before1
        );
        if (available0 > type(uint128).max || available1 > type(uint128).max) {
            revert InvalidAmount();
        }
        (uint256 tokenId, uint256 liquidity) = _mintV4Position(
            params.key,
            params.tickLower,
            params.tickUpper,
            uint128(available0),
            uint128(available1),
            params.minimumLiquidity,
            params.minimumSqrtPriceX96,
            params.maximumSqrtPriceX96,
            params.deadline,
            params.hookData,
            msg.sender
        );
        _refund(
            params.key.currency0,
            params.key.currency1,
            before0,
            before1,
            msg.sender
        );
        emit PositionZapped(
            4,
            msg.sender,
            params.sourceToken,
            params.amountIn,
            params.swapAmountIn,
            tokenId
        );
        emit V4PositionMinted(
            msg.sender,
            tokenId,
            liquidity,
            params.minimumLiquidity,
            available0,
            available1
        );
    }

    /// @notice Mints a V4 position using the caller's two-token budget. The
    ///         selected tolerance is a minimum-liquidity guarantee, not a
    ///         reduction of the liquidity requested from PositionManager.
    function mintV4(V4MintParams calldata params)
        external
        payable
        nonReentrant
        returns (uint256 tokenId, uint256 liquidity)
    {
        _validateV4Pair(
            params.key.currency0,
            params.key.currency1,
            params.deadline
        );
        if (params.amount0Max == 0 && params.amount1Max == 0) {
            revert InvalidAmount();
        }
        uint256 beforeNative = address(this).balance - msg.value;
        uint256 before0 = params.key.currency0 == address(0)
            ? beforeNative
            : _balanceOf(params.key.currency0);
        uint256 before1 = params.key.currency1 == address(0)
            ? beforeNative
            : _balanceOf(params.key.currency1);
        uint256 requiredNative;

        if (params.key.currency0 == address(0)) {
            requiredNative = params.amount0Max;
        } else if (
            params.useNativeForWeth &&
            params.key.currency0 == address(weth)
        ) {
            requiredNative = params.amount0Max;
            weth.deposit{value: params.amount0Max}();
        } else if (params.amount0Max > 0) {
            _safeTransferFrom(
                params.key.currency0,
                msg.sender,
                address(this),
                params.amount0Max
            );
        }

        if (params.key.currency1 == address(0)) {
            requiredNative += params.amount1Max;
        } else if (
            params.useNativeForWeth &&
            params.key.currency1 == address(weth)
        ) {
            requiredNative += params.amount1Max;
            weth.deposit{value: params.amount1Max}();
        } else if (params.amount1Max > 0) {
            _safeTransferFrom(
                params.key.currency1,
                msg.sender,
                address(this),
                params.amount1Max
            );
        }
        if (msg.value != requiredNative) revert InvalidAmount();

        (tokenId, liquidity) = _mintV4Position(
            params.key,
            params.tickLower,
            params.tickUpper,
            params.amount0Max,
            params.amount1Max,
            params.minimumLiquidity,
            params.minimumSqrtPriceX96,
            params.maximumSqrtPriceX96,
            params.deadline,
            params.hookData,
            msg.sender
        );
        _refund(
            params.key.currency0,
            params.key.currency1,
            before0,
            before1,
            msg.sender
        );
        emit V4PositionMinted(
            msg.sender,
            tokenId,
            liquidity,
            params.minimumLiquidity,
            params.amount0Max,
            params.amount1Max
        );
    }

    function previewV4Liquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max
    ) external view returns (uint256 liquidity, uint160 sqrtPriceX96) {
        (liquidity, sqrtPriceX96) = _maximumV4Liquidity(
            key,
            tickLower,
            tickUpper,
            amount0Max,
            amount1Max
        );
    }

    function _mintV4Position(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 minimumLiquidity,
        uint160 minimumSqrtPriceX96,
        uint160 maximumSqrtPriceX96,
        uint256 deadline,
        bytes calldata hookData,
        address recipient
    ) private returns (uint256 tokenId, uint256 liquidity) {
        uint160 sqrtPriceX96;
        (liquidity, sqrtPriceX96) = _maximumV4Liquidity(
            key,
            tickLower,
            tickUpper,
            amount0Max,
            amount1Max
        );
        if (
            minimumSqrtPriceX96 == 0 ||
            minimumSqrtPriceX96 > maximumSqrtPriceX96
        ) revert InvalidSqrtPriceBounds();
        if (
            sqrtPriceX96 < minimumSqrtPriceX96 ||
            sqrtPriceX96 > maximumSqrtPriceX96
        ) {
            revert SqrtPriceOutOfBounds(
                sqrtPriceX96,
                minimumSqrtPriceX96,
                maximumSqrtPriceX96
            );
        }
        if (liquidity < minimumLiquidity) {
            revert MinimumLiquidityNotMet(liquidity, minimumLiquidity);
        }
        if (liquidity == 0 || liquidity > type(uint128).max) {
            revert InvalidAmount();
        }
        if (amount0Max > 0 && key.currency0 != address(0)) {
            _permit(
                key.currency0,
                address(v4PositionManager),
                amount0Max,
                deadline
            );
        }
        if (amount1Max > 0 && key.currency1 != address(0)) {
            _permit(
                key.currency1,
                address(v4PositionManager),
                amount1Max,
                deadline
            );
        }

        tokenId = v4PositionManager.nextTokenId();
        bool nativePool = key.currency0 == address(0) ||
            key.currency1 == address(0);
        bytes memory actions = hex"020d";
        if (nativePool) actions = hex"020d14";
        bytes[] memory actionParams = new bytes[](nativePool ? 3 : 2);
        actionParams[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            liquidity,
            amount0Max,
            amount1Max,
            recipient,
            hookData
        );
        actionParams[1] = abi.encode(key.currency0, key.currency1);
        if (nativePool) {
            actionParams[2] = abi.encode(address(0), address(this));
        }
        uint256 nativeValue = key.currency0 == address(0)
            ? amount0Max
            : key.currency1 == address(0)
                ? amount1Max
                : 0;
        v4PositionManager.modifyLiquidities{value: nativeValue}(
            abi.encode(actions, actionParams),
            deadline
        );
        if (v4PositionManager.ownerOf(tokenId) != recipient) {
            revert InvalidAmount();
        }
        if (amount0Max > 0 && key.currency0 != address(0)) {
            _revokePermit(key.currency0, address(v4PositionManager));
        }
        if (amount1Max > 0 && key.currency1 != address(0)) {
            _revokePermit(key.currency1, address(v4PositionManager));
        }
    }

    function _maximumV4Liquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Max,
        uint128 amount1Max
    ) private view returns (uint256 liquidity, uint160 sqrtPriceX96) {
        if (
            tickLower >= tickUpper ||
            key.tickSpacing <= 0 ||
            tickLower % key.tickSpacing != 0 ||
            tickUpper % key.tickSpacing != 0
        ) revert InvalidPriceBounds();
        uint160 sqrtPriceLowerX96 = ZapTickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtPriceUpperX96 = ZapTickMath.getSqrtPriceAtTick(tickUpper);
        bytes32 poolId = keccak256(abi.encode(key));
        (sqrtPriceX96,,,) = v4StateView.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert InvalidPool();
        liquidity = _liquidityForAmounts(
            sqrtPriceX96,
            sqrtPriceLowerX96,
            sqrtPriceUpperX96,
            amount0Max,
            amount1Max
        );
    }

    function _liquidityForAmounts(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint256 amount0,
        uint256 amount1
    ) private pure returns (uint256 liquidity) {
        uint256 q96 = 1 << 96;
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            uint256 intermediate = ZapFullMath.mulDiv(
                sqrtPriceLowerX96,
                sqrtPriceUpperX96,
                q96
            );
            return ZapFullMath.mulDiv(
                amount0,
                intermediate,
                sqrtPriceUpperX96 - sqrtPriceLowerX96
            );
        }
        if (sqrtPriceX96 >= sqrtPriceUpperX96) {
            return ZapFullMath.mulDiv(
                amount1,
                q96,
                sqrtPriceUpperX96 - sqrtPriceLowerX96
            );
        }
        uint256 intermediate = ZapFullMath.mulDiv(
            sqrtPriceX96,
            sqrtPriceUpperX96,
            q96
        );
        uint256 liquidity0 = ZapFullMath.mulDiv(
            amount0,
            intermediate,
            sqrtPriceUpperX96 - sqrtPriceX96
        );
        uint256 liquidity1 = ZapFullMath.mulDiv(
            amount1,
            q96,
            sqrtPriceX96 - sqrtPriceLowerX96
        );
        liquidity = _minimum(liquidity0, liquidity1);
    }

    function _validateV3(
        address token0,
        address token1,
        address sourceToken,
        uint256 amountIn,
        uint256 deadline
    ) private view {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (
            token0 == token1 || token0.code.length == 0 ||
            token1.code.length == 0 || sourceToken.code.length == 0
        ) {
            revert InvalidPool();
        }
        if (amountIn == 0) revert InvalidAmount();
    }

    function _validateV4(
        address currency0,
        address currency1,
        address sourceToken,
        uint256 amountIn,
        uint256 deadline
    ) private view {
        _validateV4Pair(currency0, currency1, deadline);
        if (
            sourceToken != address(0) && sourceToken.code.length == 0
        ) revert InvalidPool();
        if (amountIn == 0) revert InvalidAmount();
    }

    function _validateV4Pair(
        address currency0,
        address currency1,
        uint256 deadline
    ) private view {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (
            currency0 >= currency1 ||
            (currency0 != address(0) && currency0.code.length == 0) ||
            currency1.code.length == 0
        ) revert InvalidPool();
    }

    function _prepareInput(
        address sourceToken,
        address positionToken,
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) private returns (uint256 amountOut) {
        if (sourceToken == positionToken) {
            if (path.length != 0 || amountOutMinimum != 0) {
                revert InvalidPreparationRoute();
            }
            return amountIn;
        }
        if (
            path.length < 43 || (path.length - 20) % 23 != 0 ||
            _pathAddress(path, 0) != sourceToken ||
            _pathAddress(path, path.length - 20) != positionToken
        ) revert InvalidPreparationRoute();
        _forceApprove(sourceToken, address(v3SwapRouter), amountIn);
        amountOut = v3SwapRouter.exactInput(IZapV3SwapRouter.ExactInputParams({
            path: path,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum
        }));
        _forceApprove(sourceToken, address(v3SwapRouter), 0);
    }

    function _pathAddress(bytes calldata path, uint256 offset)
        private
        pure
        returns (address token)
    {
        assembly ("memory-safe") {
            token := shr(96, calldataload(add(path.offset, offset)))
        }
    }

    function _contribution(
        address token0,
        address token1,
        uint256 before0,
        uint256 before1
    ) private view returns (uint256 amount0, uint256 amount1) {
        amount0 = _balanceOf(token0) - before0;
        amount1 = _balanceOf(token1) - before1;
    }

    function _refund(
        address token0,
        address token1,
        uint256 before0,
        uint256 before1,
        address recipient
    ) private {
        (uint256 amount0, uint256 amount1) = _contribution(token0, token1, before0, before1);
        if (amount0 > 0) _payout(token0, recipient, amount0);
        if (amount1 > 0) _payout(token1, recipient, amount1);
    }

    function _permit(address token, address spender, uint256 amount, uint256 deadline) private {
        if (amount == 0 || amount > type(uint160).max || deadline > type(uint48).max) {
            revert InvalidAmount();
        }
        if (_allowance(token, address(this), address(permit2)) < amount) {
            _forceApprove(token, address(permit2), amount);
        }
        permit2.approve(token, spender, uint160(amount), uint48(deadline));
    }

    function _revokePermit(address token, address spender) private {
        permit2.approve(token, spender, 0, 0);
        uint256 tokenAllowance = _allowance(
            token,
            address(this),
            address(permit2)
        );
        if (tokenAllowance != 0 && tokenAllowance != type(uint256).max) {
            _forceApprove(token, address(permit2), 0);
        }
    }

    function _allowance(address token, address owner_, address spender)
        private
        view
        returns (uint256 amount)
    {
        (bool success, bytes memory result) = token.staticcall(
            abi.encodeCall(IZapERC20.allowance, (owner_, spender))
        );
        if (!success || result.length < 32) revert TransferFailed();
        amount = abi.decode(result, (uint256));
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IZapERC20.approve, (spender, 0)));
        _callOptionalReturn(token, abi.encodeCall(IZapERC20.approve, (spender, amount)));
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IZapERC20.transfer, (recipient, amount)));
    }

    function _payout(address token, address recipient, uint256 amount) private {
        if (token == address(0)) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            _safeTransfer(token, recipient, amount);
        }
    }

    function _balanceOf(address token) private view returns (uint256) {
        return token == address(0)
            ? address(this).balance
            : IZapERC20(token).balanceOf(address(this));
    }

    function _safeTransferFrom(address token, address sender, address recipient, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IZapERC20.transferFrom, (sender, recipient, amount)));
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length > 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _minimum(uint256 left, uint256 right) private pure returns (uint256) {
        return left < right ? left : right;
    }
}
