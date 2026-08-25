// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplRevenueToken {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external returns (bool);
}

interface IScoplRevenueWETH is IScoplRevenueToken {
    function deposit() external payable;
}

interface IScoplRevenueReferralRewards {
    enum RevenueSource {
        LpClaim,
        LimitOrder
    }

    function referrerOf(address referred) external view returns (address);
    function creditReward(
        bytes32 revenueId,
        address referrer,
        address referred,
        address token,
        uint256 rewardAmount,
        RevenueSource source
    ) external;
}

interface IScoplRevenueCollector {
    function depositBuyback(
        bytes32 revenueKey,
        address token,
        uint256 amount
    ) external;
}

/// @notice Immediately splits every interface fee in the token actually paid:
///         30% referral (or operations when absent), 50% buyback reserve, and
///         20% operations. No oracle, normalization round, or keeper is needed.
contract ScoplRevenueDistributor {
    error ContractPaused();
    error ContractNotPaused();
    error DuplicateRevenue();
    error InvalidAmount();
    error InvalidContract();
    error InvalidNativeValue();
    error InvalidRecipient();
    error InvalidReferrer();
    error NotGuardianOrOwner();
    error NotOwner();
    error NotPendingOwner();
    error NotRevenueSource();
    error ReentrantCall();
    error TransferFailed();

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant REFERRAL_SHARE_BPS = 3_000;
    uint16 public constant BUYBACK_SHARE_BPS = 5_000;
    uint16 public constant OPERATIONAL_SHARE_BPS = 2_000;

    enum Product {
        LpClaim,
        V3LimitOrder,
        V4LimitOrder
    }

    struct RevenueSourceConfig {
        Product product;
        bool enabled;
    }

    event RevenueDistributed(
        bytes32 indexed revenueKey,
        address indexed payer,
        Product indexed product,
        address source,
        address token,
        address referrer,
        uint256 grossAmount,
        uint256 referralAmount,
        uint256 buybackAmount,
        uint256 operationalAmount
    );
    event ReferralCreditFailed(
        bytes32 indexed revenueKey,
        address indexed referrer,
        address indexed token,
        uint256 amount
    );
    event RevenueSourceUpdated(address indexed source, Product indexed product, bool enabled);
    event DestinationsUpdated(
        address indexed referralRewards,
        address indexed buybackVault,
        address indexed operationalTreasury
    );
    event BuybackCollectorUpdated(address indexed buybackCollector);
    event GuardianUpdated(address indexed guardian);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AssetRecovered(address indexed token, address indexed recipient, uint256 amount);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public immutable weth;
    address public referralRewards;
    address public buybackVault;
    address public buybackCollector;
    address public operationalTreasury;
    bool public paused;
    uint256 private reentrancyState = 1;

    mapping(address source => RevenueSourceConfig config) public revenueSources;
    mapping(bytes32 revenueKey => bool processed) public processedRevenue;

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
        address initialReferralRewards,
        address initialBuybackVault,
        address initialOperationalTreasury
    ) {
        if (initialOwner == address(0)) revert InvalidRecipient();
        if (wethAddress.code.length == 0) revert InvalidContract();
        owner = initialOwner;
        guardian = initialGuardian;
        weth = wethAddress;
        _setDestinations(
            initialReferralRewards,
            initialBuybackVault,
            initialOperationalTreasury
        );
        emit OwnershipTransferred(address(0), initialOwner);
        emit GuardianUpdated(initialGuardian);
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

    function setGuardian(address nextGuardian) external onlyOwner {
        guardian = nextGuardian;
        emit GuardianUpdated(nextGuardian);
    }

    function setDestinations(
        address nextReferralRewards,
        address nextBuybackVault,
        address nextOperationalTreasury
    ) external onlyOwner {
        _setDestinations(
            nextReferralRewards,
            nextBuybackVault,
            nextOperationalTreasury
        );
    }

    /// @notice Selects the protocol-only local collector for new multi-chain
    ///         deployments. Zero preserves the legacy direct-vault path.
    function setBuybackCollector(address nextCollector) external onlyOwner {
        if (nextCollector != address(0) && nextCollector.code.length == 0) {
            revert InvalidContract();
        }
        buybackCollector = nextCollector;
        emit BuybackCollectorUpdated(nextCollector);
    }

    function setRevenueSource(address source, Product product, bool enabled)
        external onlyOwner
    {
        if (source == address(0)) revert InvalidRecipient();
        if (enabled && source.code.length == 0) revert InvalidContract();
        revenueSources[source] = RevenueSourceConfig(product, enabled);
        emit RevenueSourceUpdated(source, product, enabled);
    }

    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        if (paused) revert ContractPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert ContractNotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function distribute(
        bytes32 sourceRevenueId,
        address payer,
        address token,
        uint256 grossAmount
    ) external payable nonReentrant {
        _distribute(
            sourceRevenueId,
            payer,
            address(0),
            false,
            token,
            grossAmount
        );
    }

    /// @notice Uses the immutable referrer recorded by a V2 order. A trusted
    ///         manager may deliberately pass zero for an integration order,
    ///         even when the trader has a separate direct-order referral.
    function distributeAttributed(
        bytes32 sourceRevenueId,
        address payer,
        address attributedReferrer,
        address token,
        uint256 grossAmount
    ) external payable nonReentrant {
        _distribute(
            sourceRevenueId,
            payer,
            attributedReferrer,
            true,
            token,
            grossAmount
        );
    }

    function _distribute(
        bytes32 sourceRevenueId,
        address payer,
        address attributedReferrer,
        bool hasExplicitAttribution,
        address token,
        uint256 grossAmount
    ) private {
        if (paused) revert ContractPaused();
        RevenueSourceConfig memory sourceConfig = revenueSources[msg.sender];
        if (!sourceConfig.enabled) revert NotRevenueSource();
        if (sourceRevenueId == bytes32(0) || payer == address(0) || grossAmount == 0) {
            revert InvalidAmount();
        }
        bytes32 revenueKey = keccak256(
            abi.encode(block.chainid, msg.sender, sourceRevenueId)
        );
        if (processedRevenue[revenueKey]) revert DuplicateRevenue();
        processedRevenue[revenueKey] = true;

        address feeToken = token;
        if (token == address(0)) {
            if (msg.value != grossAmount) revert InvalidNativeValue();
            IScoplRevenueWETH(weth).deposit{value: grossAmount}();
            feeToken = weth;
        } else {
            if (msg.value != 0) revert InvalidNativeValue();
            if (token.code.length == 0) revert InvalidContract();
            uint256 beforeBalance = _balanceOf(token);
            _safeTransferFrom(token, msg.sender, address(this), grossAmount);
            if (_balanceOf(token) - beforeBalance != grossAmount) revert TransferFailed();
        }

        address referrer;
        if (hasExplicitAttribution) {
            referrer = attributedReferrer;
            // Approved revenue sources, including the V2 order managers, pass
            // attribution that was validated and frozen when the order was
            // created. Re-reading a mutable referral destination here would
            // make historical orders dependent on current governance config.
            if (referrer == payer) revert InvalidReferrer();
        } else {
            referrer = _tryReferrerOf(payer);
        }
        uint256 referralAmount = referrer == address(0)
            ? 0
            : grossAmount * REFERRAL_SHARE_BPS / BPS_DENOMINATOR;
        uint256 buybackAmount = grossAmount * BUYBACK_SHARE_BPS / BPS_DENOMINATOR;
        uint256 operationalAmount = grossAmount - referralAmount - buybackAmount;

        if (referralAmount > 0) {
            bool credited = _tryCreditReferral(
                revenueKey,
                payer,
                referrer,
                feeToken,
                referralAmount,
                sourceConfig.product
            );
            if (!credited) {
                emit ReferralCreditFailed(
                    revenueKey,
                    referrer,
                    feeToken,
                    referralAmount
                );
                operationalAmount += referralAmount;
                referralAmount = 0;
            }
        }
        _routeBuyback(revenueKey, feeToken, buybackAmount);
        _transferAsset(feeToken, operationalTreasury, operationalAmount);
        emit RevenueDistributed(
            revenueKey,
            payer,
            sourceConfig.product,
            msg.sender,
            feeToken,
            referrer,
            grossAmount,
            referralAmount,
            buybackAmount,
            operationalAmount
        );
    }

    function recoverAsset(address token, address recipient, uint256 amount)
        external onlyOwner nonReentrant
    {
        if (!paused) revert ContractPaused();
        if (recipient == address(0)) revert InvalidRecipient();
        _transferAsset(token, recipient, amount);
        emit AssetRecovered(token, recipient, amount);
    }

    function _tryCreditReferral(
        bytes32 revenueKey,
        address payer,
        address referrer,
        address token,
        uint256 amount,
        Product product
    ) private returns (bool credited) {
        uint256 beforeBalance = _balanceOf(token);
        if (!_callApprove(token, referralRewards, 0)) return false;
        if (!_callApprove(token, referralRewards, amount)) {
            if (!_callApprove(token, referralRewards, 0)) revert TransferFailed();
            return false;
        }
        try IScoplRevenueReferralRewards(referralRewards).creditReward(
            revenueKey,
            referrer,
            payer,
            token,
            amount,
            product == Product.LpClaim
                ? IScoplRevenueReferralRewards.RevenueSource.LpClaim
                : IScoplRevenueReferralRewards.RevenueSource.LimitOrder
        ) {
            uint256 afterBalance = _balanceOf(token);
            credited = afterBalance <= beforeBalance &&
                beforeBalance - afterBalance == amount;
        } catch {
            credited = false;
        }
        if (!_callApprove(token, referralRewards, 0)) revert TransferFailed();
    }

    function _routeBuyback(
        bytes32 revenueKey,
        address token,
        uint256 amount
    ) private {
        address collector = buybackCollector;
        if (collector == address(0)) {
            _transferAsset(token, buybackVault, amount);
            return;
        }
        uint256 beforeBalance = _balanceOf(token);
        if (!_callApprove(token, collector, 0)) revert TransferFailed();
        if (!_callApprove(token, collector, amount)) revert TransferFailed();
        IScoplRevenueCollector(collector).depositBuyback(
            revenueKey,
            token,
            amount
        );
        if (!_callApprove(token, collector, 0)) revert TransferFailed();
        if (beforeBalance - _balanceOf(token) != amount) revert TransferFailed();
    }

    function _tryReferrerOf(address payer) private view returns (address referrer) {
        (bool success, bytes memory data) = referralRewards.staticcall{gas: 30_000}(
            abi.encodeCall(IScoplRevenueReferralRewards.referrerOf, (payer))
        );
        if (!success || data.length < 32) return address(0);
        referrer = abi.decode(data, (address));
        if (referrer == payer) return address(0);
    }

    function _setDestinations(
        address nextReferralRewards,
        address nextBuybackVault,
        address nextOperationalTreasury
    ) private {
        if (nextOperationalTreasury == address(0)) revert InvalidRecipient();
        if (
            nextReferralRewards.code.length == 0 ||
            nextBuybackVault.code.length == 0
        ) revert InvalidContract();
        referralRewards = nextReferralRewards;
        buybackVault = nextBuybackVault;
        operationalTreasury = nextOperationalTreasury;
        emit DestinationsUpdated(
            nextReferralRewards,
            nextBuybackVault,
            nextOperationalTreasury
        );
    }

    function _balanceOf(address token) private view returns (uint256) {
        return token == address(0)
            ? address(this).balance
            : IScoplRevenueToken(token).balanceOf(address(this));
    }

    function _transferAsset(address token, address recipient, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool nativeSuccess, ) = recipient.call{value: amount}("");
            if (!nativeSuccess) revert TransferFailed();
            return;
        }
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplRevenueToken.transfer, (recipient, amount))
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
            abi.encodeCall(IScoplRevenueToken.transferFrom, (sender, recipient, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _callApprove(address token, address spender, uint256 amount)
        private returns (bool)
    {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplRevenueToken.approve, (spender, amount))
        );
        return success &&
            (result.length == 0 || (result.length >= 32 && abi.decode(result, (bool))));
    }
}
