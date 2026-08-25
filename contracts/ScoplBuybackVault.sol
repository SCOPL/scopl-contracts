// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplBuybackERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IScoplBuybackWETH is IScoplBuybackERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IScoplPonsV2Factory {
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

    function getLaunchedToken(address token)
        external
        view
        returns (LaunchedToken memory);
    function memeHook() external view returns (address);
    function graduate(address token) external;
    function createGraduatedPool(address token)
        external
        returns (uint256 positionId);
}

interface IScoplPonsV2Curve {
    function readyToGraduate() external view returns (bool);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
}

interface IScoplBuybackAdapter {
    /// @dev The adapter must deliver output to `recipient`. The vault verifies
    ///      the actual balance delta and does not trust the return value.
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient,
        bytes calldata data
    ) external;
}

/// @notice Holds buyback revenue and lets a revocable keeper consolidate fee
///         tokens into WETH, then buy SCOPL through a pinned router adapter.
/// @dev The executor is deliberately trusted to choose routes and minimum
///      outputs. It is revocable by the owner, while the adapter and router
///      bytecode are pinned on-chain. A small fixed WETH-funded native reward
///      keeps the executor supplied with gas without an oracle or gas-price
///      accounting system.
contract ScoplBuybackVault {
    error ContractPaused();
    error InsufficientBalance();
    error InsufficientKeeperReward();
    error InvalidAmount();
    error InvalidContract();
    error InvalidRecipient();
    error InvalidSwapPair();
    error InvalidPonsLaunch();
    error InvalidPonsPhase();
    error NotExecutor();
    error NotGuardianOrOwner();
    error NotOwner();
    error NotPendingOwner();
    error BuybackConfigurationFinalized();
    error BuybackConfigurationNotFinalized();
    error ProtectedAsset();
    error ReentrantCall();
    error SlippageExceeded();
    error TransferFailed();
    error UnauthorizedAdapter();

    uint256 public constant MAX_KEEPER_REWARD_WEI = 0.001 ether;

    event BuybackConfigured(
        address indexed buybackToken,
        address indexed recipient
    );
    event BuybackConfigurationFinalizedEvent(address indexed buybackToken);
    event AdapterPermissionUpdated(
        address indexed adapter,
        bool allowed,
        bytes32 codeHash
    );
    event ExecutorPermissionUpdated(address indexed executor, bool allowed);
    event KeeperRewardUpdated(uint256 rewardWei);
    event GuardianUpdated(address indexed guardian);
    event BuybackSwapExecuted(
        address indexed executor,
        address indexed adapter,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minimumAmountOut,
        uint256 keeperReward
    );
    event PonsCurveBuyExecuted(
        address indexed executor,
        address indexed curve,
        address indexed pairToken,
        uint256 quoteIn,
        uint256 quoteSpent,
        uint256 amountOut,
        uint256 minimumAmountOut,
        uint256 keeperReward
    );
    event PonsGraduationAdvanced(
        address indexed executor,
        uint8 phaseBefore,
        uint8 phaseAfter,
        uint256 keeperReward
    );
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AssetRecovered(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public immutable weth;
    address public immutable ponsV2Factory;
    address public buybackToken;
    address public buybackRecipient;
    uint256 public keeperRewardWei;
    bool public buybackConfigured;
    bool public buybackConfigurationFinalized;
    bool public paused;
    uint256 private reentrancyState = 1;

    mapping(address executor => bool allowed) public executors;
    mapping(address adapter => bool allowed) public allowedAdapters;
    mapping(address adapter => bytes32 codeHash) public adapterCodeHash;

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
        address initialGuardian,
        address wethAddress,
        address ponsV2FactoryAddress,
        uint256 initialKeeperRewardWei
    ) {
        if (initialOwner == address(0)) revert InvalidRecipient();
        if (wethAddress.code.length == 0) revert InvalidContract();
        if (ponsV2FactoryAddress.code.length == 0) revert InvalidContract();
        if (
            initialKeeperRewardWei == 0 ||
            initialKeeperRewardWei > MAX_KEEPER_REWARD_WEI
        ) revert InvalidAmount();
        owner = initialOwner;
        guardian = initialGuardian;
        weth = wethAddress;
        ponsV2Factory = ponsV2FactoryAddress;
        keeperRewardWei = initialKeeperRewardWei;
        emit OwnershipTransferred(address(0), initialOwner);
        emit GuardianUpdated(initialGuardian);
        emit KeeperRewardUpdated(initialKeeperRewardWei);
    }

    receive() external payable {}

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

    /// @notice Selects SCOPL as the reserve asset. Purchased tokens remain in
    ///         this vault and are never transferred to POL or an external burn
    ///         address.
    function configureBuyback(address token) external onlyOwner {
        if (buybackConfigurationFinalized) {
            revert BuybackConfigurationFinalized();
        }
        if (token.code.length == 0) revert InvalidContract();
        if (token == weth) revert InvalidSwapPair();
        buybackToken = token;
        buybackRecipient = address(this);
        buybackConfigured = true;
        emit BuybackConfigured(token, address(this));
    }

    function finalizeBuybackConfiguration() external onlyOwner {
        if (buybackConfigurationFinalized) {
            revert BuybackConfigurationFinalized();
        }
        if (!buybackConfigured) revert BuybackConfigurationNotFinalized();
        buybackConfigurationFinalized = true;
        emit BuybackConfigurationFinalizedEvent(buybackToken);
    }

    function setGuardian(address nextGuardian) external onlyOwner {
        guardian = nextGuardian;
        emit GuardianUpdated(nextGuardian);
    }

    function setExecutor(address executor, bool allowed) external onlyOwner {
        if (executor == address(0)) revert InvalidRecipient();
        executors[executor] = allowed;
        emit ExecutorPermissionUpdated(executor, allowed);
    }

    function setKeeperRewardWei(uint256 nextRewardWei) external onlyOwner {
        if (nextRewardWei == 0 || nextRewardWei > MAX_KEEPER_REWARD_WEI) {
            revert InvalidAmount();
        }
        keeperRewardWei = nextRewardWei;
        emit KeeperRewardUpdated(nextRewardWei);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        if (adapter == address(0)) revert InvalidRecipient();
        if (allowed && adapter.code.length == 0) revert InvalidContract();
        allowedAdapters[adapter] = allowed;
        bytes32 codeHash = allowed ? adapter.codehash : bytes32(0);
        adapterCodeHash[adapter] = codeHash;
        emit AdapterPermissionUpdated(adapter, allowed, codeHash);
    }

    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) {
            revert NotGuardianOrOwner();
        }
        if (paused) revert ContractPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert ContractPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function executeSwap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        bytes calldata data
    ) external nonReentrant returns (uint256 amountOut) {
        if (paused) revert ContractPaused();
        if (!executors[msg.sender]) revert NotExecutor();
        if (!buybackConfigurationFinalized) {
            revert BuybackConfigurationNotFinalized();
        }
        if (
            !allowedAdapters[adapter] ||
            adapterCodeHash[adapter] == bytes32(0) ||
            adapterCodeHash[adapter] != adapter.codehash
        ) revert UnauthorizedAdapter();
        if (
            tokenIn.code.length == 0 ||
            tokenOut.code.length == 0
        ) revert InvalidContract();
        if (!_isAllowedSwapPair(tokenIn, tokenOut)) revert InvalidSwapPair();
        if (amountIn == 0 || minimumAmountOut == 0) revert InvalidAmount();
        if (_balanceOf(tokenIn) < amountIn) revert InsufficientBalance();
        uint256 beforeInput = _balanceOf(tokenIn);
        uint256 beforeOutput = _balanceOf(tokenOut);
        _forceApprove(tokenIn, adapter, amountIn);
        IScoplBuybackAdapter(adapter).executeSwap(
            tokenIn,
            tokenOut,
            amountIn,
            minimumAmountOut,
            address(this),
            data
        );
        _forceApprove(tokenIn, adapter, 0);
        if (beforeInput - _balanceOf(tokenIn) != amountIn) {
            revert TransferFailed();
        }
        amountOut = _balanceOf(tokenOut) - beforeOutput;
        if (amountOut < minimumAmountOut) revert SlippageExceeded();
        uint256 keeperReward = _payKeeperReward();
        emit BuybackSwapExecuted(
            msg.sender,
            adapter,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            minimumAmountOut,
            keeperReward
        );
    }

    /// @notice Buys SCOPL from its live Pons V2 bonding curve. The vault is
    ///         the quote payer and token recipient, so a clamped final buy
    ///         returns its unused quote directly here. Native refunds are
    ///         immediately rewrapped to WETH for the next keeper cycle.
    function executePonsCurveBuy(
        uint256 quoteIn,
        uint256 minimumAmountOut
    ) external nonReentrant returns (uint256 amountOut, uint256 quoteRefund) {
        if (paused) revert ContractPaused();
        if (!executors[msg.sender]) revert NotExecutor();
        if (!buybackConfigurationFinalized) {
            revert BuybackConfigurationNotFinalized();
        }
        if (quoteIn == 0 || minimumAmountOut == 0) revert InvalidAmount();

        IScoplPonsV2Factory.LaunchedToken memory launch =
            _ponsLaunch();
        if (
            launch.phase !=
                IScoplPonsV2Factory.GraduationPhase.NotGraduated
        ) revert InvalidPonsPhase();
        if (launch.curve.code.length == 0) revert InvalidContract();

        uint256 outputBefore = _balanceOf(buybackToken);
        uint256 quoteSpent;
        if (launch.pairToken == address(0)) {
            if (_balanceOf(weth) < quoteIn) revert InsufficientBalance();
            uint256 nativeBefore = address(this).balance;
            IScoplBuybackWETH(weth).withdraw(quoteIn);
            IScoplPonsV2Curve(launch.curve).buy{value: quoteIn}(
                quoteIn,
                minimumAmountOut,
                address(this)
            );
            uint256 nativeAfter = address(this).balance;
            if (nativeAfter < nativeBefore) revert TransferFailed();
            quoteRefund = nativeAfter - nativeBefore;
            if (quoteRefund > quoteIn) revert TransferFailed();
            quoteSpent = quoteIn - quoteRefund;
            if (quoteRefund != 0) {
                IScoplBuybackWETH(weth).deposit{value: quoteRefund}();
            }
        } else {
            if (_balanceOf(launch.pairToken) < quoteIn) {
                revert InsufficientBalance();
            }
            uint256 quoteBefore = _balanceOf(launch.pairToken);
            _forceApprove(launch.pairToken, launch.curve, quoteIn);
            IScoplPonsV2Curve(launch.curve).buy(
                quoteIn,
                minimumAmountOut,
                address(this)
            );
            _forceApprove(launch.pairToken, launch.curve, 0);
            uint256 quoteAfter = _balanceOf(launch.pairToken);
            if (quoteAfter > quoteBefore) revert TransferFailed();
            quoteSpent = quoteBefore - quoteAfter;
            if (quoteSpent > quoteIn) revert TransferFailed();
            quoteRefund = quoteIn - quoteSpent;
        }

        amountOut = _balanceOf(buybackToken) - outputBefore;
        if (
            quoteSpent == 0 || amountOut == 0 ||
            quoteSpent * minimumAmountOut > quoteIn * amountOut
        ) revert SlippageExceeded();
        uint256 keeperReward = _payKeeperReward();
        emit PonsCurveBuyExecuted(
            msg.sender,
            launch.curve,
            launch.pairToken,
            quoteIn,
            quoteSpent,
            amountOut,
            minimumAmountOut,
            keeperReward
        );
    }

    /// @notice Advances a ready Pons launch by exactly one permissionless
    ///         graduation phase. The keeper deliberately retries the actual
    ///         buyback on its next cycle against freshly-read Factory state.
    function advancePonsGraduation()
        external
        nonReentrant
        returns (uint8 phaseBefore, uint8 phaseAfter)
    {
        if (paused) revert ContractPaused();
        if (!executors[msg.sender]) revert NotExecutor();
        if (!buybackConfigurationFinalized) {
            revert BuybackConfigurationNotFinalized();
        }
        IScoplPonsV2Factory.LaunchedToken memory launch =
            _ponsLaunch();
        phaseBefore = uint8(launch.phase);
        if (
            launch.phase ==
                IScoplPonsV2Factory.GraduationPhase.NotGraduated
        ) {
            if (!IScoplPonsV2Curve(launch.curve).readyToGraduate()) {
                revert InvalidPonsPhase();
            }
            IScoplPonsV2Factory(ponsV2Factory).graduate(buybackToken);
        } else if (
            launch.phase == IScoplPonsV2Factory.GraduationPhase.Swept
        ) {
            IScoplPonsV2Factory(ponsV2Factory).createGraduatedPool(
                buybackToken
            );
        } else {
            revert InvalidPonsPhase();
        }
        phaseAfter = uint8(_ponsLaunch().phase);
        uint256 keeperReward = _payKeeperReward();
        emit PonsGraduationAdvanced(
            msg.sender,
            phaseBefore,
            phaseAfter,
            keeperReward
        );
    }

    /// @notice Emergency recovery is owner-only and available only while
    ///         paused. Production ownership should be a timelock-controlled
    ///         multisig or DAO.
    function recoverAsset(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (!paused) revert ContractPaused();
        if (recipient == address(0)) revert InvalidRecipient();
        if (buybackConfigurationFinalized && token == buybackToken) {
            revert ProtectedAsset();
        }
        _transferAsset(token, recipient, amount);
        emit AssetRecovered(token, recipient, amount);
    }

    function _balanceOf(address token) private view returns (uint256) {
        return token == address(0)
            ? address(this).balance
            : IScoplBuybackERC20(token).balanceOf(address(this));
    }

    function _ponsLaunch()
        private
        view
        returns (IScoplPonsV2Factory.LaunchedToken memory launch)
    {
        launch = IScoplPonsV2Factory(ponsV2Factory).getLaunchedToken(
            buybackToken
        );
        if (
            !launch.exists || launch.token != buybackToken ||
            launch.curve == address(0)
        ) revert InvalidPonsLaunch();
    }

    function _isAllowedSwapPair(address tokenIn, address tokenOut)
        private
        view
        returns (bool)
    {
        IScoplPonsV2Factory.LaunchedToken memory launch =
            IScoplPonsV2Factory(ponsV2Factory).getLaunchedToken(
                buybackToken
            );
        bool validPonsLaunch = launch.exists &&
            launch.token == buybackToken && launch.curve != address(0);

        if (
            tokenOut == weth && tokenIn != weth && tokenIn != buybackToken
        ) {
            // Preserve the live Pons quote asset instead of accidentally
            // consolidating it back to WETH between buys.
            return !validPonsLaunch || tokenIn != launch.pairToken ||
                launch.phase == IScoplPonsV2Factory.GraduationPhase.Rescued;
        }
        if (!validPonsLaunch) {
            return tokenIn == weth && tokenOut == buybackToken;
        }
        bool usablePhase =
            launch.phase == IScoplPonsV2Factory.GraduationPhase.NotGraduated ||
            launch.phase == IScoplPonsV2Factory.GraduationPhase.PoolCreated;
        bool quotePreparation = launch.pairToken != address(0) &&
            launch.pairToken != weth && tokenIn == weth &&
            tokenOut == launch.pairToken && usablePhase;
        address graduatedInput = launch.pairToken == address(0)
            ? weth
            : launch.pairToken;
        bool graduatedPurchase = tokenIn == graduatedInput &&
            tokenOut == buybackToken &&
            launch.phase == IScoplPonsV2Factory.GraduationPhase.PoolCreated;
        return quotePreparation || graduatedPurchase;
    }

    function _payKeeperReward() private returns (uint256 keeperReward) {
        keeperReward = keeperRewardWei;
        if (_balanceOf(weth) < keeperReward) {
            revert InsufficientKeeperReward();
        }
        IScoplBuybackWETH(weth).withdraw(keeperReward);
        (bool success, ) = payable(msg.sender).call{value: keeperReward}("");
        if (!success) revert TransferFailed();
    }

    function _transferAsset(
        address token,
        address recipient,
        uint256 amount
    ) private {
        if (token == address(0)) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            _safeTransfer(token, recipient, amount);
        }
    }

    function _safeTransfer(address token, address recipient, uint256 amount)
        private
    {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IScoplBuybackERC20.transfer, (recipient, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _forceApprove(
        address token,
        address spender,
        uint256 amount
    ) private {
        if (!_callApprove(token, spender, 0)) revert TransferFailed();
        if (amount != 0 && !_callApprove(token, spender, amount)) {
            revert TransferFailed();
        }
    }

    function _callApprove(
        address token,
        address spender,
        uint256 amount
    ) private returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IScoplBuybackERC20.approve, (spender, amount))
        );
        return success &&
            (data.length == 0 ||
                (data.length >= 32 && abi.decode(data, (bool))));
    }
}
