// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IMockRevenueDistributor {
    function distribute(
        bytes32 sourceRevenueId,
        address payer,
        address token,
        uint256 grossAmount
    ) external payable;
    function distributeAttributed(
        bytes32 sourceRevenueId,
        address payer,
        address referrer,
        address token,
        uint256 grossAmount
    ) external payable;
}

interface IMockRevenueCollector {
    function depositBuyback(bytes32 revenueKey, address token, uint256 amount) external;
}

contract MockRevenueToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "native");
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

contract MockRevenueSource {
    function distributeToken(
        address distributor,
        bytes32 revenueId,
        address payer,
        address token,
        uint256 amount
    ) external {
        MockRevenueToken(token).approve(distributor, amount);
        IMockRevenueDistributor(distributor).distribute(
            revenueId,
            payer,
            token,
            amount
        );
    }

    function distributeAttributedToken(
        address distributor,
        bytes32 revenueId,
        address payer,
        address referrer,
        address token,
        uint256 amount
    ) external {
        MockRevenueToken(token).approve(distributor, amount);
        IMockRevenueDistributor(distributor).distributeAttributed(
            revenueId, payer, referrer, token, amount
        );
    }

    function depositCollector(
        address collector,
        bytes32 revenueKey,
        address token,
        uint256 amount
    ) external {
        MockRevenueToken(token).approve(collector, amount);
        IMockRevenueCollector(collector).depositBuyback(revenueKey, token, amount);
    }

    function distributeNative(
        address distributor,
        bytes32 revenueId,
        address payer
    ) external payable {
        IMockRevenueDistributor(distributor).distribute{value: msg.value}(
            revenueId,
            payer,
            address(0),
            msg.value
        );
    }
}

contract MockCollectorAdapter {
    uint256 public amountOut;

    function setAmountOut(uint256 nextAmountOut) external {
        amountOut = nextAmountOut;
    }

    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256,
        address recipient,
        bytes calldata
    ) external {
        MockRevenueToken(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockRevenueToken(tokenOut).mint(recipient, amountOut);
    }
}

contract MockCollectorBridgeProvider {
    address public lastWeth;
    uint256 public lastAmount;
    uint256 public lastDestinationChainId;
    address public lastDestinationVault;
    bytes public lastProviderData;

    function bridgeWeth(
        address weth,
        uint256 amount,
        uint256 destinationChainId,
        address destinationVault,
        bytes calldata providerData
    ) external {
        MockRevenueToken(weth).transferFrom(msg.sender, address(this), amount);
        lastWeth = weth;
        lastAmount = amount;
        lastDestinationChainId = destinationChainId;
        lastDestinationVault = destinationVault;
        lastProviderData = providerData;
    }
}

contract MockRevenueReceiver {
    receive() external payable {}
}

contract RevertingRevenueReferral {
    address public immutable weth;

    constructor(address wethAddress) {
        weth = wethAddress;
    }

    function referrerOf(address) external pure returns (address) {
        revert("referral unavailable");
    }
}

contract MockBuybackAdapter {
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient,
        bytes calldata data
    ) external payable {
        uint256 amountOut = abi.decode(data, (uint256));
        require(amountOut >= amountOutMinimum, "minimum");
        if (tokenIn == address(0)) {
            require(msg.value == amountIn, "value");
        } else {
            MockRevenueToken(tokenIn).transferFrom(
                msg.sender,
                address(this),
                amountIn
            );
        }
        MockRevenueToken(tokenOut).mint(recipient, amountOut);
    }
}

contract MockAggregationRouter {
    address public immutable permit2;

    constructor(address permit2Address) {
        permit2 = permit2Address;
    }

    receive() external payable {}

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        MockRevenuePermit2(permit2).transferFrom(
            msg.sender,
            address(this),
            uint160(amountIn),
            tokenIn
        );
        MockRevenueToken(tokenOut).mint(msg.sender, amountOut);
    }

    function swapTokenForNative(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        MockRevenuePermit2(permit2).transferFrom(
            msg.sender,
            address(this),
            uint160(amountIn),
            tokenIn
        );
        (bool success, ) = payable(msg.sender).call{value: amountOut}("");
        require(success, "native output");
    }

    function swapNativeForToken(address tokenOut, uint256 amountOut)
        external
        payable
    {
        MockRevenueToken(tokenOut).mint(msg.sender, amountOut);
    }
}

contract MockRevenuePermit2 {
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
        uint160 allowed = allowance[sender][token][msg.sender];
        require(allowed >= amount, "permit2 allowance");
        allowance[sender][token][msg.sender] = allowed - amount;
        MockRevenueToken(token).transferFrom(sender, recipient, amount);
    }
}

contract MockPonsCurve {
    uint256 private constant BPS = 10_000;

    address public immutable token;
    address public immutable pairToken;
    uint256 public quoteReserve;
    uint256 public tokenReserve;
    uint256 public sellableTokens;
    uint256 public feeBps;
    uint256 public creatorTaxBps;
    uint256 public snipeTaxBps;
    bool public readyToGraduate;

    constructor(address tokenAddress, address pairTokenAddress) {
        token = tokenAddress;
        pairToken = pairTokenAddress;
    }

    receive() external payable {}

    function configure(
        uint256 quoteReserve_,
        uint256 tokenReserve_,
        uint256 sellableTokens_,
        uint256 feeBps_,
        uint256 creatorTaxBps_,
        uint256 snipeTaxBps_
    ) external {
        quoteReserve = quoteReserve_;
        tokenReserve = tokenReserve_;
        sellableTokens = sellableTokens_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
        snipeTaxBps = snipeTaxBps_;
        readyToGraduate = sellableTokens_ == 0;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (quoteReserve, tokenReserve);
    }

    function currentSnipeTaxBps(address) external view returns (uint256) {
        return snipeTaxBps;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (pairToken == address(0)) {
            require(msg.value == quoteIn, "value");
        } else {
            require(msg.value == 0, "native");
            MockRevenueToken(pairToken).transferFrom(
                msg.sender,
                address(this),
                quoteIn
            );
        }
        uint256 totalFeeBps = feeBps + creatorTaxBps + snipeTaxBps;
        uint256 netQuote = quoteIn
            - (quoteIn * feeBps) / BPS
            - (quoteIn * creatorTaxBps) / BPS
            - (quoteIn * snipeTaxBps) / BPS;
        tokensOut = (netQuote * tokenReserve) / (quoteReserve + netQuote);
        uint256 spent = quoteIn;
        if (tokensOut > sellableTokens) {
            tokensOut = sellableTokens;
            uint256 netRequired =
                (tokensOut * quoteReserve) / (tokenReserve - tokensOut) + 1;
            spent = _ceilDiv(netRequired * BPS, BPS - totalFeeBps);
            if (spent > quoteIn) spent = quoteIn;
        }
        require(spent * minTokensOut <= quoteIn * tokensOut, "slippage");
        require(tokensOut != 0, "zero");
        MockRevenueToken(token).mint(recipient, tokensOut);
        uint256 refund = quoteIn - spent;
        if (refund != 0) {
            if (pairToken == address(0)) {
                (bool success, ) = payable(msg.sender).call{value: refund}("");
                require(success, "refund");
            } else {
                MockRevenueToken(pairToken).transfer(msg.sender, refund);
            }
        }
        quoteReserve += spent;
        tokenReserve -= tokensOut;
        sellableTokens -= tokensOut;
        readyToGraduate = sellableTokens == 0;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator)
        private
        pure
        returns (uint256)
    {
        return (numerator + denominator - 1) / denominator;
    }
}

contract MockPonsFactory {
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    address public immutable memeHook;
    mapping(address => LaunchedToken) private launches;

    constructor(address memeHookAddress) {
        memeHook = memeHookAddress;
    }

    function setLaunch(
        address token,
        address curve,
        address pairToken,
        uint24 poolFee,
        int24 tickSpacing,
        GraduationPhase phase
    ) external {
        launches[token] = LaunchedToken({
            token: token,
            curve: curve,
            deployer: msg.sender,
            creatorFeeRecipient: msg.sender,
            pairToken: pairToken,
            graduationThreshold: 1,
            poolFee: poolFee,
            tickSpacing: tickSpacing,
            creatorTaxBps: 0,
            buybackEnabled: false,
            phase: phase,
            sweptQuote: 0,
            sweptTokens: 0,
            sweptAt: 0,
            exists: true
        });
    }

    function getLaunchedToken(address token)
        external
        view
        returns (LaunchedToken memory)
    {
        return launches[token];
    }

    function graduate(address token) external {
        LaunchedToken storage launch = launches[token];
        require(
            launch.phase == GraduationPhase.NotGraduated &&
                MockPonsCurve(payable(launch.curve)).readyToGraduate(),
            "phase"
        );
        launch.phase = GraduationPhase.Swept;
    }

    function createGraduatedPool(address token) external returns (uint256) {
        LaunchedToken storage launch = launches[token];
        require(launch.phase == GraduationPhase.Swept, "phase");
        launch.phase = GraduationPhase.PoolCreated;
        return 1;
    }
}
