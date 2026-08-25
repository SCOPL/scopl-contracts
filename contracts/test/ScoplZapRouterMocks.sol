// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract ZapMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) internal allowances;

    function allowance(address owner, address spender)
        public
        view
        virtual
        returns (uint256)
    {
        return allowances[owner][spender];
    }

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount)
        public
        virtual
        returns (bool)
    {
        allowances[msg.sender][spender] = amount;
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
        uint256 available = allowance(sender, msg.sender);
        require(available >= amount, "allowance");
        require(balanceOf[sender] >= amount, "balance");
        if (available != type(uint256).max) {
            allowances[sender][msg.sender] = available - amount;
        }
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract ZapMockFixedPermit2ERC20 is ZapMockERC20 {
    error Permit2AllowanceIsFixedAtInfinity();

    address public immutable fixedPermit2;

    constructor(address permit2Address) {
        fixedPermit2 = permit2Address;
    }

    function allowance(address owner, address spender)
        public
        view
        override
        returns (uint256)
    {
        if (spender == fixedPermit2) return type(uint256).max;
        return super.allowance(owner, spender);
    }

    function approve(address spender, uint256 amount)
        public
        override
        returns (bool)
    {
        if (spender == fixedPermit2 && amount != type(uint256).max) {
            revert Permit2AllowanceIsFixedAtInfinity();
        }
        return super.approve(spender, amount);
    }
}

contract ZapMockWETH is ZapMockERC20 {
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "native");
    }
}

contract ZapMockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160)))
        public allowance;

    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48
    ) external {
        allowance[msg.sender][token][spender] = amount;
    }

    function transferFrom(
        address sender,
        address recipient,
        uint160 amount,
        address token
    ) external {
        uint160 available = allowance[sender][token][msg.sender];
        require(available >= amount, "permit allowance");
        allowance[sender][token][msg.sender] = available - amount;
        require(
            ZapMockERC20(token).transferFrom(sender, recipient, amount),
            "permit transfer"
        );
    }
}

contract ZapMockV3SwapRouter {
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
        returns (uint256 amountOut)
    {
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "slippage");
        ZapMockERC20(params.tokenIn).transferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        ZapMockERC20(params.tokenOut).mint(params.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(params.path.length >= 43, "path");
        address tokenIn = _pathAddress(params.path, 0);
        address tokenOut = _pathAddress(params.path, params.path.length - 20);
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "slippage");
        ZapMockERC20(tokenIn).transferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        ZapMockERC20(tokenOut).mint(params.recipient, amountOut);
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
}

contract ZapMockV3PositionManager {
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

    uint256 public nextTokenId = 1;
    mapping(uint256 => address) public ownerOf;

    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        require(block.timestamp <= params.deadline, "deadline");
        amount0 = params.amount0Desired * 3 / 4;
        amount1 = params.amount1Desired * 3 / 4;
        require(amount0 >= params.amount0Min, "amount0 min");
        require(amount1 >= params.amount1Min, "amount1 min");
        if (amount0 > 0) {
            ZapMockERC20(params.token0).transferFrom(
                msg.sender,
                address(this),
                amount0
            );
        }
        if (amount1 > 0) {
            ZapMockERC20(params.token1).transferFrom(
                msg.sender,
                address(this),
                amount1
            );
        }
        tokenId = nextTokenId++;
        ownerOf[tokenId] = params.recipient;
        liquidity = uint128(amount0 + amount1);
    }
}

contract ZapMockUniversalRouter {
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

    ZapMockPermit2 public immutable permit2;
    address public postSwapStateView;
    bytes32 public postSwapPoolId;
    uint160 public postSwapSqrtPriceX96;

    constructor(address permit2Address) {
        permit2 = ZapMockPermit2(permit2Address);
    }

    receive() external payable {}

    function setPostSwapPrice(
        address stateView,
        bytes32 poolId,
        uint160 sqrtPriceX96
    ) external {
        postSwapStateView = stateView;
        postSwapPoolId = poolId;
        postSwapSqrtPriceX96 = sqrtPriceX96;
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "deadline");
        require(keccak256(commands) == keccak256(hex"10"), "command");
        (bytes memory actions, bytes[] memory params) =
            abi.decode(inputs[0], (bytes, bytes[]));
        bool nativeInput = keccak256(actions) == keccak256(hex"060c0f");
        require(
            nativeInput || keccak256(actions) == keccak256(hex"060b0f"),
            "actions"
        );
        V4SwapParams memory swapParams = abi.decode(
            params[0],
            (V4SwapParams)
        );
        address settledToken;
        uint256 settledAmount;
        bool payerIsUser;
        if (nativeInput) {
            (settledToken, settledAmount) = abi.decode(
                params[1],
                (address, uint256)
            );
            payerIsUser = true;
            require(settledToken == address(0), "native input");
            require(msg.value == settledAmount, "native value");
        } else {
            (settledToken, settledAmount, payerIsUser) = abi.decode(
                params[1],
                (address, uint256, bool)
            );
        }
        (address outputToken, uint256 minimumOutput) =
            abi.decode(params[2], (address, uint256));
        require(payerIsUser, "payer");
        require(settledAmount == swapParams.amountIn, "amount");
        require(
            settledToken ==
                (swapParams.zeroForOne
                    ? swapParams.poolKey.currency0
                    : swapParams.poolKey.currency1),
            "input"
        );
        require(
            outputToken ==
                (swapParams.zeroForOne
                    ? swapParams.poolKey.currency1
                    : swapParams.poolKey.currency0),
            "output"
        );
        require(settledAmount >= minimumOutput, "slippage");
        if (!nativeInput) {
            permit2.transferFrom(
                msg.sender,
                address(this),
                uint160(settledAmount),
                settledToken
            );
        }
        if (outputToken == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: settledAmount}("");
            require(success, "native output");
        } else {
            ZapMockERC20(outputToken).mint(msg.sender, settledAmount);
        }
        if (postSwapStateView != address(0)) {
            ZapMockV4StateView(postSwapStateView).setSlot0(
                postSwapPoolId,
                postSwapSqrtPriceX96
            );
        }
    }
}

contract ZapMockPoolManager {}

contract ZapMockV4StateView {
    address public immutable poolManager;
    mapping(bytes32 => uint160) public sqrtPriceX96Of;

    constructor(address poolManagerAddress) {
        poolManager = poolManagerAddress;
    }

    function setSlot0(bytes32 poolId, uint160 sqrtPriceX96) external {
        sqrtPriceX96Of[poolId] = sqrtPriceX96;
    }

    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        sqrtPriceX96 = sqrtPriceX96Of[poolId];
    }
}

contract ZapMockV4PositionManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    ZapMockPermit2 public immutable permit2;
    address public immutable poolManager;
    uint256 public nextTokenId = 1;
    uint256 public lastLiquidity;
    mapping(uint256 => address) public ownerOf;

    constructor(address permit2Address, address poolManagerAddress) {
        permit2 = ZapMockPermit2(permit2Address);
        poolManager = poolManagerAddress;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable
    {
        require(block.timestamp <= deadline, "deadline");
        (bytes memory actions, bytes[] memory params) =
            abi.decode(unlockData, (bytes, bytes[]));
        (
            PoolKey memory key,
            ,
            ,
            uint256 liquidity,
            uint128 amount0Max,
            uint128 amount1Max,
            address recipient,
        ) = abi.decode(
            params[0],
            (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes)
        );
        require(liquidity > 0, "liquidity");
        lastLiquidity = liquidity;
        (address currency0, address currency1) =
            abi.decode(params[1], (address, address));
        require(currency0 == key.currency0 && currency1 == key.currency1, "pair");
        bool nativePool = currency0 == address(0) || currency1 == address(0);
        bytes memory expectedActions = hex"020d";
        if (nativePool) expectedActions = hex"020d14";
        require(keccak256(actions) == keccak256(expectedActions), "actions");
        require(params.length == (nativePool ? 3 : 2), "params");
        uint160 amount0 = uint160(uint256(amount0Max) * 3 / 4);
        uint160 amount1 = uint160(uint256(amount1Max) * 3 / 4);
        uint256 nativeUsed;
        if (amount0 > 0 && currency0 == address(0)) {
            nativeUsed += amount0;
        } else if (amount0 > 0) {
            permit2.transferFrom(msg.sender, address(this), amount0, currency0);
        }
        if (amount1 > 0 && currency1 == address(0)) {
            nativeUsed += amount1;
        } else if (amount1 > 0) {
            permit2.transferFrom(msg.sender, address(this), amount1, currency1);
        }
        require(msg.value >= nativeUsed, "native mint value");
        if (nativePool) {
            (address sweepCurrency, address sweepRecipient) = abi.decode(
                params[2],
                (address, address)
            );
            require(sweepCurrency == address(0), "sweep currency");
            (bool success, ) = payable(sweepRecipient).call{
                value: address(this).balance
            }("");
            require(success, "native sweep");
        }
        uint256 tokenId = nextTokenId++;
        ownerOf[tokenId] = recipient;
    }
}
