// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplCollectorERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external returns (bool);
}

interface IScoplCollectorSwapAdapter {
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient,
        bytes calldata data
    ) external;
}

interface IScoplRevenueBridgeProvider {
    function bridgeWeth(
        address weth,
        uint256 amount,
        uint256 destinationChainId,
        address destinationVault,
        bytes calldata providerData
    ) external;
}

/// @notice Holds only the buyback allocation of protocol-owned revenue on a
///         source chain, normalizes it to WETH, and exposes a replaceable
///         transport-provider boundary to the canonical Robinhood vault.
contract ScoplRevenueCollector {
    error ContractPaused();
    error DuplicateDeposit();
    error DuplicateSweep();
    error InsufficientBalance();
    error InvalidAmount();
    error InvalidContract();
    error InvalidRecipient();
    error NotBridgeExecutor();
    error NotNormalizer();
    error NotOwner();
    error NotPendingOwner();
    error NotRevenueSource();
    error ReentrantCall();
    error SlippageExceeded();
    error TransferFailed();
    error UnauthorizedAdapter();
    error UnauthorizedProvider();

    event BuybackRevenueDeposited(
        bytes32 indexed revenueKey,
        address indexed source,
        address indexed token,
        uint256 amount
    );
    event RevenueNormalized(
        bytes32 indexed normalizationId,
        address indexed tokenIn,
        address indexed adapter,
        uint256 amountIn,
        uint256 wethOut
    );
    event RevenueSweepSubmitted(
        bytes32 indexed sweepId,
        address indexed provider,
        uint256 amount,
        uint256 destinationChainId,
        address destinationVault
    );
    event RevenueSourceUpdated(address indexed source, bool allowed);
    event NormalizerUpdated(address indexed normalizer, bool allowed);
    event BridgeExecutorUpdated(address indexed executor, bool allowed);
    event AdapterUpdated(address indexed adapter, bool allowed, bytes32 codeHash);
    event BridgeProviderUpdated(address indexed provider, bool allowed, bytes32 codeHash);
    event PauseUpdated(bool paused);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    address public immutable weth;
    uint256 public immutable destinationChainId;
    address public immutable destinationVault;
    bool public paused;
    uint256 private reentrancyState = 1;

    mapping(address source => bool allowed) public revenueSources;
    mapping(address normalizer => bool allowed) public normalizers;
    mapping(address executor => bool allowed) public bridgeExecutors;
    mapping(address adapter => bool allowed) public allowedAdapters;
    mapping(address adapter => bytes32 codeHash) public adapterCodeHash;
    mapping(address provider => bool allowed) public allowedBridgeProviders;
    mapping(address provider => bytes32 codeHash) public bridgeProviderCodeHash;
    mapping(address token => uint256 amount) public accountedBuybackBalance;
    mapping(bytes32 revenueKey => bool processed) public processedDeposits;
    mapping(bytes32 normalizationId => bool processed) public processedNormalizations;
    mapping(bytes32 sweepId => bool processed) public processedSweeps;

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
        address wethAddress,
        uint256 canonicalDestinationChainId,
        address canonicalDestinationVault
    ) {
        if (
            initialOwner == address(0) ||
            canonicalDestinationVault == address(0)
        ) revert InvalidRecipient();
        if (wethAddress.code.length == 0) revert InvalidContract();
        if (canonicalDestinationChainId == 0) revert InvalidAmount();
        owner = initialOwner;
        weth = wethAddress;
        destinationChainId = canonicalDestinationChainId;
        destinationVault = canonicalDestinationVault;
        emit OwnershipTransferred(address(0), initialOwner);
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

    function setRevenueSource(address source, bool allowed) external onlyOwner {
        if (source == address(0) || (allowed && source.code.length == 0)) {
            revert InvalidContract();
        }
        revenueSources[source] = allowed;
        emit RevenueSourceUpdated(source, allowed);
    }

    function setNormalizer(address normalizer, bool allowed) external onlyOwner {
        if (normalizer == address(0)) revert InvalidRecipient();
        normalizers[normalizer] = allowed;
        emit NormalizerUpdated(normalizer, allowed);
    }

    function setBridgeExecutor(address executor, bool allowed) external onlyOwner {
        if (executor == address(0)) revert InvalidRecipient();
        bridgeExecutors[executor] = allowed;
        emit BridgeExecutorUpdated(executor, allowed);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        if (adapter == address(0) || (allowed && adapter.code.length == 0)) {
            revert InvalidContract();
        }
        allowedAdapters[adapter] = allowed;
        adapterCodeHash[adapter] = allowed ? adapter.codehash : bytes32(0);
        emit AdapterUpdated(adapter, allowed, adapterCodeHash[adapter]);
    }

    function setBridgeProvider(address provider, bool allowed) external onlyOwner {
        if (provider == address(0) || (allowed && provider.code.length == 0)) {
            revert InvalidContract();
        }
        allowedBridgeProviders[provider] = allowed;
        bridgeProviderCodeHash[provider] = allowed
            ? provider.codehash
            : bytes32(0);
        emit BridgeProviderUpdated(
            provider,
            allowed,
            bridgeProviderCodeHash[provider]
        );
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseUpdated(nextPaused);
    }

    /// @notice Pulls an exact buyback allocation from an approved distributor.
    ///         Operations/referral/user/integrator balances never call this path.
    function depositBuyback(
        bytes32 revenueKey,
        address token,
        uint256 amount
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (!revenueSources[msg.sender]) revert NotRevenueSource();
        if (revenueKey == bytes32(0) || processedDeposits[revenueKey]) {
            revert DuplicateDeposit();
        }
        if (token.code.length == 0) revert InvalidContract();
        if (amount == 0) revert InvalidAmount();
        processedDeposits[revenueKey] = true;
        uint256 beforeBalance = _balanceOf(token);
        _safeTransferFrom(token, msg.sender, address(this), amount);
        if (_balanceOf(token) - beforeBalance != amount) revert TransferFailed();
        accountedBuybackBalance[token] += amount;
        emit BuybackRevenueDeposited(revenueKey, msg.sender, token, amount);
    }

    function normalizeToWeth(
        bytes32 normalizationId,
        address tokenIn,
        uint256 amountIn,
        address adapter,
        uint256 minimumWethOut,
        bytes calldata adapterData
    ) external nonReentrant returns (uint256 wethOut) {
        if (paused) revert ContractPaused();
        if (!normalizers[msg.sender]) revert NotNormalizer();
        if (normalizationId == bytes32(0) || processedNormalizations[normalizationId]) {
            revert DuplicateDeposit();
        }
        if (tokenIn == weth || amountIn == 0 || minimumWethOut == 0) {
            revert InvalidAmount();
        }
        if (accountedBuybackBalance[tokenIn] < amountIn) {
            revert InsufficientBalance();
        }
        if (
            !allowedAdapters[adapter] ||
            adapterCodeHash[adapter] == bytes32(0) ||
            adapterCodeHash[adapter] != adapter.codehash
        ) revert UnauthorizedAdapter();
        processedNormalizations[normalizationId] = true;
        uint256 tokenBefore = _balanceOf(tokenIn);
        uint256 wethBefore = _balanceOf(weth);
        _forceApprove(tokenIn, adapter, amountIn);
        IScoplCollectorSwapAdapter(adapter).executeSwap(
            tokenIn,
            weth,
            amountIn,
            minimumWethOut,
            address(this),
            adapterData
        );
        _forceApprove(tokenIn, adapter, 0);
        if (tokenBefore - _balanceOf(tokenIn) != amountIn) {
            revert TransferFailed();
        }
        wethOut = _balanceOf(weth) - wethBefore;
        if (wethOut < minimumWethOut) revert SlippageExceeded();
        accountedBuybackBalance[tokenIn] -= amountIn;
        accountedBuybackBalance[weth] += wethOut;
        emit RevenueNormalized(
            normalizationId,
            tokenIn,
            adapter,
            amountIn,
            wethOut
        );
    }

    function bridgeWeth(
        bytes32 sweepId,
        uint256 amount,
        address provider,
        bytes calldata providerData
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (!bridgeExecutors[msg.sender]) revert NotBridgeExecutor();
        if (sweepId == bytes32(0) || processedSweeps[sweepId]) {
            revert DuplicateSweep();
        }
        if (amount == 0 || accountedBuybackBalance[weth] < amount) {
            revert InsufficientBalance();
        }
        if (
            !allowedBridgeProviders[provider] ||
            bridgeProviderCodeHash[provider] == bytes32(0) ||
            bridgeProviderCodeHash[provider] != provider.codehash
        ) revert UnauthorizedProvider();
        processedSweeps[sweepId] = true;
        uint256 beforeBalance = _balanceOf(weth);
        _forceApprove(weth, provider, amount);
        IScoplRevenueBridgeProvider(provider).bridgeWeth(
            weth,
            amount,
            destinationChainId,
            destinationVault,
            providerData
        );
        _forceApprove(weth, provider, 0);
        if (beforeBalance - _balanceOf(weth) != amount) revert TransferFailed();
        accountedBuybackBalance[weth] -= amount;
        emit RevenueSweepSubmitted(
            sweepId,
            provider,
            amount,
            destinationChainId,
            destinationVault
        );
    }

    function excessBalance(address token) external view returns (uint256) {
        uint256 actual = _balanceOf(token);
        uint256 accounted = accountedBuybackBalance[token];
        return actual > accounted ? actual - accounted : 0;
    }

    function recoverExcess(address token, address recipient, uint256 amount)
        external onlyOwner nonReentrant
    {
        if (!paused) revert ContractPaused();
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 actual = _balanceOf(token);
        uint256 accounted = accountedBuybackBalance[token];
        if (actual < accounted || amount > actual - accounted) {
            revert InsufficientBalance();
        }
        _safeTransfer(token, recipient, amount);
    }

    function _balanceOf(address token) private view returns (uint256) {
        return IScoplCollectorERC20(token).balanceOf(address(this));
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplCollectorERC20.transfer, (recipient, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(
        address token,
        address sender,
        address recipient,
        uint256 amount
    ) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(
                IScoplCollectorERC20.transferFrom,
                (sender, recipient, amount)
            )
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0)) revert TransferFailed();
        if (!_tryApprove(token, spender, amount)) revert TransferFailed();
    }

    function _tryApprove(address token, address spender, uint256 amount)
        private returns (bool)
    {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplCollectorERC20.approve, (spender, amount))
        );
        return success && (
            result.length == 0 ||
            (result.length >= 32 && abi.decode(result, (bool)))
        );
    }
}
