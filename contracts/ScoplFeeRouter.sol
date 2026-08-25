// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWETH is IERC20 {
    function withdraw(uint256 amount) external;
}

interface IScoplFeeRevenueDistributor {
    function distribute(
        bytes32 sourceRevenueId,
        address payer,
        address token,
        uint256 grossAmount
    ) external payable;
}

interface IERC721Manager {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IV3PositionManager is IERC721Manager {
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

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128 liquidity,
            uint256,
            uint256,
            uint128,
            uint128
        );

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;
}

interface IV4PositionManager is IERC721Manager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, uint256 info);

    function getPositionLiquidity(uint256 tokenId)
        external
        view
        returns (uint128 liquidity);

    function poolManager() external view returns (address);

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable;

    function burn(uint256 tokenId) external payable;
}

/// @notice Optional SCOPL interface for collecting V3/V4 LP earnings and
///         applying the configured SCOPL interface fee.
/// @dev Position NFTs remain user-owned. Owners can always manage them through
///      the canonical Uniswap Position Manager without using this interface.
contract ScoplFeeRouter {
    error ContractPaused();
    error ContractNotPaused();
    error InvalidBatchSize();
    error InvalidContract();
    error InvalidFee();
    error InvalidRecipient();
    error NotOwner();
    error NotPendingOwner();
    error PositionChanged();
    error ReentrantCall();
    error TransferFailed();
    error UnexpectedNativeSender();
    error UnsupportedManager();

    event FeeCharged(
        address indexed user,
        address indexed token,
        uint256 amount,
        uint16 feeBps
    );
    event FeesClaimed(
        uint8 indexed version,
        uint256 indexed tokenId,
        address indexed owner,
        address token0,
        address token1,
        uint256 grossAmount0,
        uint256 grossAmount1,
        uint256 protocolFee0,
        uint256 protocolFee1
    );
    event FeesBatchClaimed(
        address indexed owner,
        uint256 v3PositionCount,
        uint256 v4PositionCount
    );
    event LiquidityRemoved(
        uint8 indexed version,
        uint256 indexed tokenId,
        address indexed owner,
        uint128 liquidityRemoved,
        uint128 liquidityRemaining,
        uint256 principal0,
        uint256 principal1
    );
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AssetRecovered(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );
    event RevenueDistributorUpdated(address indexed revenueDistributor);
    event FeeConfigurationUpdated(address indexed feeToken, uint16 baseFeeBps);
    event DiscountTierUpdated(uint8 indexed tier, uint256 minimumBalance, uint16 feeBps);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct DiscountTier {
        uint256 minimumBalance;
        uint16 feeBps;
    }

    string public constant VERSION = "3.0.0";
    uint16 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_BATCH_POSITIONS = 20;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint128 private constant MAX_UINT128 = type(uint128).max;
    uint256 private constant FEE_TOKEN_BALANCE_GAS = 30_000;
    bytes1 private constant V4_INCREASE_LIQUIDITY = 0x00;
    bytes1 private constant V4_DECREASE_LIQUIDITY = 0x01;
    bytes1 private constant V4_BURN_POSITION = 0x03;
    bytes1 private constant V4_TAKE_PAIR = 0x11;

    IV3PositionManager public immutable v3PositionManager;
    IV4PositionManager public immutable v4PositionManager;
    address public immutable v4PoolManager;
    IWETH public immutable weth;

    address public owner;
    address public pendingOwner;
    address public revenueDistributor;
    address public feeToken;
    uint16 public baseFeeBps = 500;
    bool public paused;
    uint256 private locked = 1;
    uint256 private nextRevenueNonce = 1;

    DiscountTier[3] public discountTiers;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier whenPaused() {
        if (!paused) revert ContractNotPaused();
        _;
    }

    constructor(
        address initialOwner,
        address initialRevenueDistributor,
        address v3Manager,
        address v4Manager,
        address wethAddress
    ) {
        if (
            initialOwner == address(0) ||
            initialRevenueDistributor == address(0)
        ) {
            revert InvalidRecipient();
        }
        if (
            v3Manager.code.length == 0 ||
            v4Manager.code.length == 0 ||
            wethAddress.code.length == 0 ||
            initialRevenueDistributor.code.length == 0
        ) revert InvalidContract();
        address v4PoolManagerAddress =
            IV4PositionManager(v4Manager).poolManager();
        if (v4PoolManagerAddress.code.length == 0) revert InvalidContract();
        owner = initialOwner;
        revenueDistributor = initialRevenueDistributor;
        v3PositionManager = IV3PositionManager(v3Manager);
        v4PositionManager = IV4PositionManager(v4Manager);
        v4PoolManager = v4PoolManagerAddress;
        weth = IWETH(wethAddress);
    }

    receive() external payable {
        if (
            msg.sender != address(weth) &&
            msg.sender != v4PoolManager
        ) revert UnexpectedNativeSender();
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidRecipient();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function setRevenueDistributor(address nextRevenueDistributor)
        external
        onlyOwner
    {
        if (nextRevenueDistributor.code.length == 0) revert InvalidContract();
        revenueDistributor = nextRevenueDistributor;
        emit RevenueDistributorUpdated(nextRevenueDistributor);
    }

    function pause() external onlyOwner {
        if (paused) revert ContractPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert ContractNotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setFeeConfiguration(address nextFeeToken, uint16 nextBaseFeeBps)
        external
        onlyOwner
    {
        if (nextBaseFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (nextFeeToken != address(0) && nextFeeToken.code.length == 0) {
            revert InvalidContract();
        }
        feeToken = nextFeeToken;
        baseFeeBps = nextBaseFeeBps;
        emit FeeConfigurationUpdated(nextFeeToken, nextBaseFeeBps);
    }

    function setDiscountTier(
        uint8 tier,
        uint256 minimumBalance,
        uint16 feeBps
    ) external onlyOwner {
        if (tier >= discountTiers.length || feeBps > baseFeeBps) {
            revert InvalidFee();
        }
        discountTiers[tier] = DiscountTier(minimumBalance, feeBps);
        emit DiscountTierUpdated(tier, minimumBalance, feeBps);
    }

    function setFeeSchedule(
        address nextFeeToken,
        uint16 nextBaseFeeBps,
        uint256[3] calldata minimumBalances,
        uint16[3] calldata tierFeeBps
    ) external onlyOwner {
        if (nextBaseFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (nextFeeToken != address(0) && nextFeeToken.code.length == 0) {
            revert InvalidContract();
        }

        uint256 previousMinimumBalance;
        uint16 previousFeeBps = nextBaseFeeBps;
        bool disabledTierSeen;
        for (uint8 tier = 0; tier < discountTiers.length; tier++) {
            uint256 minimumBalance = minimumBalances[tier];
            uint16 feeBps = tierFeeBps[tier];
            if (minimumBalance == 0) {
                if (feeBps != 0) revert InvalidFee();
                disabledTierSeen = true;
            } else {
                if (
                    disabledTierSeen ||
                    minimumBalance <= previousMinimumBalance ||
                    feeBps > previousFeeBps
                ) revert InvalidFee();
                previousMinimumBalance = minimumBalance;
                previousFeeBps = feeBps;
            }
        }

        feeToken = nextFeeToken;
        baseFeeBps = nextBaseFeeBps;
        emit FeeConfigurationUpdated(nextFeeToken, nextBaseFeeBps);
        for (uint8 tier = 0; tier < discountTiers.length; tier++) {
            discountTiers[tier] = DiscountTier(
                minimumBalances[tier],
                tierFeeBps[tier]
            );
            emit DiscountTierUpdated(
                tier,
                minimumBalances[tier],
                tierFeeBps[tier]
            );
        }
    }

    function feeBpsFor(address user) public view returns (uint16 feeBps) {
        feeBps = baseFeeBps;
        if (feeToken == address(0)) return feeBps;
        (bool success, uint256 balance) =
            _tryBalanceOf(feeToken, user);
        if (!success) return feeBps;
        for (uint256 index = 0; index < discountTiers.length; index++) {
            DiscountTier memory tier = discountTiers[index];
            if (
                tier.minimumBalance > 0 &&
                balance >= tier.minimumBalance &&
                tier.feeBps < feeBps
            ) {
                feeBps = tier.feeBps;
            }
        }
    }

    function previewFee(address user, uint256 grossAmount)
        external
        view
        returns (uint256 protocolFee, uint256 userAmount)
    {
        protocolFee = _calculateFee(grossAmount, feeBpsFor(user));
        userAmount = grossAmount - protocolFee;
    }

    function recoverAsset(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner whenPaused nonReentrant {
        if (recipient == address(0)) revert InvalidRecipient();
        _payout(token, recipient, amount, false);
        emit AssetRecovered(token, recipient, amount);
    }

    function claimV3(uint256 tokenId, bool unwrapWeth)
        external
        whenNotPaused
        nonReentrant
    {
        uint16 effectiveFeeBps = feeBpsFor(msg.sender);
        _claimV3(tokenId, msg.sender, unwrapWeth, effectiveFeeBps);
    }

    function claimAll(
        uint256[] calldata v3TokenIds,
        uint256[] calldata v4TokenIds,
        uint256 deadline,
        bool unwrapWeth
    ) external whenNotPaused nonReentrant {
        uint256 total = v3TokenIds.length + v4TokenIds.length;
        if (total == 0 || total > MAX_BATCH_POSITIONS) {
            revert InvalidBatchSize();
        }
        uint16 effectiveFeeBps = feeBpsFor(msg.sender);
        for (uint256 index = 0; index < v3TokenIds.length; index++) {
            _claimV3(
                v3TokenIds[index],
                msg.sender,
                unwrapWeth,
                effectiveFeeBps
            );
        }
        for (uint256 index = 0; index < v4TokenIds.length; index++) {
            _claimV4(
                v4TokenIds[index],
                msg.sender,
                deadline,
                unwrapWeth,
                effectiveFeeBps
            );
        }
        emit FeesBatchClaimed(
            msg.sender,
            v3TokenIds.length,
            v4TokenIds.length
        );
    }

    function _claimV3(
        uint256 tokenId,
        address user,
        bool unwrapWeth,
        uint16 effectiveFeeBps
    ) private {
        (address token0, address token1, ) = _currentV3(tokenId, user);
        (
            uint256 amount0,
            uint256 amount1,
            uint256 chargeable0,
            uint256 chargeable1
        ) = _collectV3(tokenId);
        uint256 protocolFee0 =
            _distributeFeeFromBase(
                token0,
                user,
                amount0,
                chargeable0,
                unwrapWeth,
                effectiveFeeBps
            );
        uint256 protocolFee1 =
            _distributeFeeFromBase(
                token1,
                user,
                amount1,
                chargeable1,
                unwrapWeth,
                effectiveFeeBps
            );
        emit FeesClaimed(
            3,
            tokenId,
            user,
            token0,
            token1,
            amount0,
            amount1,
            protocolFee0,
            protocolFee1
        );
    }

    function removeV3(
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline,
        bool unwrapWeth,
        bool burnIfEmpty
    ) external whenNotPaused nonReentrant {
        (address token0, address token1, uint128 currentLiquidity) =
            _currentV3(tokenId, msg.sender);
        if (liquidityToRemove == 0 || liquidityToRemove > currentLiquidity) {
            revert PositionChanged();
        }
        uint16 effectiveFeeBps = feeBpsFor(msg.sender);

        (
            uint256 fee0,
            uint256 fee1,
            uint256 chargeableFee0,
            uint256 chargeableFee1
        ) = _collectV3(tokenId);
        v3PositionManager.decreaseLiquidity(
            IV3PositionManager.DecreaseLiquidityParams(
                tokenId,
                liquidityToRemove,
                amount0Min,
                amount1Min,
                deadline
            )
        );
        (uint256 principal0, uint256 principal1, , ) = _collectV3(tokenId);

        uint128 remaining = currentLiquidity - liquidityToRemove;
        if (remaining == 0) {
            if (burnIfEmpty) v3PositionManager.burn(tokenId);
        }
        uint256 protocolFee0 =
            _distributeFeeFromBase(
                token0,
                msg.sender,
                fee0,
                chargeableFee0,
                unwrapWeth,
                effectiveFeeBps
            );
        uint256 protocolFee1 =
            _distributeFeeFromBase(
                token1,
                msg.sender,
                fee1,
                chargeableFee1,
                unwrapWeth,
                effectiveFeeBps
            );
        _payout(token0, msg.sender, principal0, unwrapWeth);
        _payout(token1, msg.sender, principal1, unwrapWeth);
        emit FeesClaimed(
            3,
            tokenId,
            msg.sender,
            token0,
            token1,
            fee0,
            fee1,
            protocolFee0,
            protocolFee1
        );
        emit LiquidityRemoved(
            3,
            tokenId,
            msg.sender,
            liquidityToRemove,
            remaining,
            principal0,
            principal1
        );
    }

    function claimV4(uint256 tokenId, uint256 deadline, bool unwrapWeth)
        external
        whenNotPaused
        nonReentrant
    {
        uint16 effectiveFeeBps = feeBpsFor(msg.sender);
        _claimV4(
            tokenId,
            msg.sender,
            deadline,
            unwrapWeth,
            effectiveFeeBps
        );
    }

    function _claimV4(
        uint256 tokenId,
        address user,
        uint256 deadline,
        bool unwrapWeth,
        uint16 effectiveFeeBps
    ) private {
        _currentV4(tokenId, user);
        (IV4PositionManager.PoolKey memory key, uint256 amount0, uint256 amount1) =
            _collectV4(tokenId, deadline);
        uint256 protocolFee0 =
            _distributeFee(
                key.currency0,
                user,
                amount0,
                unwrapWeth,
                effectiveFeeBps
            );
        uint256 protocolFee1 =
            _distributeFee(
                key.currency1,
                user,
                amount1,
                unwrapWeth,
                effectiveFeeBps
            );
        emit FeesClaimed(
            4,
            tokenId,
            user,
            key.currency0,
            key.currency1,
            amount0,
            amount1,
            protocolFee0,
            protocolFee1
        );
    }

    function removeV4(
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline,
        bool unwrapWeth,
        bool burnIfEmpty
    ) external whenNotPaused nonReentrant {
        uint128 currentLiquidity = _currentV4(tokenId, msg.sender);
        if (liquidityToRemove == 0 || liquidityToRemove > currentLiquidity) {
            revert PositionChanged();
        }
        uint16 effectiveFeeBps = feeBpsFor(msg.sender);
        (
            IV4PositionManager.PoolKey memory key,
            uint256 fee0,
            uint256 fee1
        ) =
            _collectV4(tokenId, deadline);
        bytes memory actions = liquidityToRemove == currentLiquidity && burnIfEmpty
            ? abi.encodePacked(V4_BURN_POSITION, V4_TAKE_PAIR)
            : abi.encodePacked(V4_DECREASE_LIQUIDITY, V4_TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        if (liquidityToRemove == currentLiquidity && burnIfEmpty) {
            params[0] = abi.encode(tokenId, amount0Min, amount1Min, bytes(""));
        } else {
            params[0] = abi.encode(
                tokenId,
                uint256(liquidityToRemove),
                amount0Min,
                amount1Min,
                bytes("")
            );
        }
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        uint256 before0 = _balanceOf(key.currency0);
        uint256 before1 = _balanceOf(key.currency1);
        v4PositionManager.modifyLiquidities(
            abi.encode(actions, params),
            deadline
        );
        uint256 principal0 = _balanceOf(key.currency0) - before0;
        uint256 principal1 = _balanceOf(key.currency1) - before1;

        uint128 remaining = currentLiquidity - liquidityToRemove;
        uint256 protocolFee0 =
            _distributeFee(
                key.currency0,
                msg.sender,
                fee0,
                unwrapWeth,
                effectiveFeeBps
            );
        uint256 protocolFee1 =
            _distributeFee(
                key.currency1,
                msg.sender,
                fee1,
                unwrapWeth,
                effectiveFeeBps
            );
        _payout(key.currency0, msg.sender, principal0, unwrapWeth);
        _payout(key.currency1, msg.sender, principal1, unwrapWeth);
        emit FeesClaimed(
            4,
            tokenId,
            msg.sender,
            key.currency0,
            key.currency1,
            fee0,
            fee1,
            protocolFee0,
            protocolFee1
        );
        emit LiquidityRemoved(
            4,
            tokenId,
            msg.sender,
            liquidityToRemove,
            remaining,
            principal0,
            principal1
        );
    }

    function _currentV3(uint256 tokenId, address user)
        private
        view
        returns (address token0, address token1, uint128 liquidity)
    {
        _requireNftOwner(address(v3PositionManager), tokenId, user);
        (, , token0, token1, , , , liquidity, , , , ) =
            v3PositionManager.positions(tokenId);
    }

    function _currentV4(uint256 tokenId, address user)
        private
        view
        returns (uint128 liquidity)
    {
        _requireNftOwner(address(v4PositionManager), tokenId, user);
        liquidity = v4PositionManager.getPositionLiquidity(tokenId);
    }

    function _collectV3(uint256 tokenId)
        private
        returns (
            uint256 amount0,
            uint256 amount1,
            uint256 chargeable0,
            uint256 chargeable1
        )
    {
        (
            ,
            ,
            address token0,
            address token1,
            ,
            ,
            ,
            ,
            ,
            ,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        ) =
            v3PositionManager.positions(tokenId);
        uint256 before0 = _balanceOf(token0);
        uint256 before1 = _balanceOf(token1);
        v3PositionManager.collect(
            IV3PositionManager.CollectParams(
                tokenId,
                address(this),
                MAX_UINT128,
                MAX_UINT128
            )
        );
        amount0 = _balanceOf(token0) - before0;
        amount1 = _balanceOf(token1) - before1;
        // Uniswap V3 combines previously removed principal and checkpointed
        // fees in tokensOwed. Only value realized above the pre-collection
        // tokensOwed balance is unambiguously new fee growth.
        if (amount0 > tokensOwed0) chargeable0 = amount0 - tokensOwed0;
        if (amount1 > tokensOwed1) chargeable1 = amount1 - tokensOwed1;
    }

    function _collectV4(uint256 tokenId, uint256 deadline)
        private
        returns (
            IV4PositionManager.PoolKey memory key,
            uint256 amount0,
            uint256 amount1
        )
    {
        (key, ) = v4PositionManager.getPoolAndPositionInfo(tokenId);
        uint256 before0 = _balanceOf(key.currency0);
        uint256 before1 = _balanceOf(key.currency1);
        _collectV4To(tokenId, address(this), deadline);
        amount0 = _balanceOf(key.currency0) - before0;
        amount1 = _balanceOf(key.currency1) - before1;
    }

    function _collectV4To(
        uint256 tokenId,
        address recipient,
        uint256 deadline
    ) private {
        (IV4PositionManager.PoolKey memory key, ) =
            v4PositionManager.getPoolAndPositionInfo(tokenId);
        bytes memory actions =
            abi.encodePacked(V4_INCREASE_LIQUIDITY, V4_TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            tokenId,
            uint256(0),
            uint128(0),
            uint128(0),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1, recipient);
        v4PositionManager.modifyLiquidities(
            abi.encode(actions, params),
            deadline
        );
    }

    function _distributeFee(
        address token,
        address user,
        uint256 amount,
        bool unwrapWeth,
        uint16 feeBps
    ) private returns (uint256 protocolFee) {
        return _distributeFeeFromBase(
            token,
            user,
            amount,
            amount,
            unwrapWeth,
            feeBps
        );
    }

    function _distributeFeeFromBase(
        address token,
        address user,
        uint256 amount,
        uint256 feeBaseAmount,
        bool unwrapWeth,
        uint16 feeBps
    ) private returns (uint256 protocolFee) {
        if (feeBaseAmount > amount) revert InvalidFee();
        protocolFee = _calculateFee(feeBaseAmount, feeBps);
        if (protocolFee > 0) {
            _routeRevenue(token, user, protocolFee);
            emit FeeCharged(user, token, protocolFee, feeBps);
        }
        _payout(token, user, amount - protocolFee, unwrapWeth);
    }

    function _routeRevenue(
        address token,
        address user,
        uint256 protocolFee
    ) private {
        address distributor = revenueDistributor;
        bytes32 revenueId = keccak256(
            abi.encode(address(this), nextRevenueNonce++, user, token)
        );
        uint256 beforeBalance = _balanceOf(token);
        if (token == address(0)) {
            IScoplFeeRevenueDistributor(distributor).distribute{
                value: protocolFee
            }(revenueId, user, token, protocolFee);
        } else {
            if (!_tryApprove(token, distributor, protocolFee)) {
                revert TransferFailed();
            }
            IScoplFeeRevenueDistributor(distributor).distribute(
                revenueId,
                user,
                token,
                protocolFee
            );
            if (!_tryApprove(token, distributor, 0)) revert TransferFailed();
        }
        if (beforeBalance - _balanceOf(token) != protocolFee) {
            revert TransferFailed();
        }
    }

    function _payout(
        address token,
        address recipient,
        uint256 amount,
        bool unwrapWeth
    ) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert TransferFailed();
            return;
        }
        if (token == address(weth) && unwrapWeth) {
            weth.withdraw(amount);
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert TransferFailed();
            return;
        }
        _safeTransfer(token, recipient, amount);
    }

    function _balanceOf(address token) private view returns (uint256) {
        return token == address(0)
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
    }

    function _calculateFee(uint256 amount, uint16 feeBps)
        private
        pure
        returns (uint256)
    {
        uint256 whole = amount / BPS_DENOMINATOR;
        uint256 remainder = amount % BPS_DENOMINATOR;
        return whole * feeBps + remainder * feeBps / BPS_DENOMINATOR;
    }

    function _tryBalanceOf(address token, address account)
        private
        view
        returns (bool success, uint256 tokenBalance)
    {
        uint256 gasLimit = FEE_TOKEN_BALANCE_GAS;
        assembly ("memory-safe") {
            let pointer := mload(0x40)
            mstore(pointer, shl(224, 0x70a08231))
            mstore(add(pointer, 0x04), account)
            success := staticcall(gasLimit, token, pointer, 0x24, pointer, 0x20)
            if lt(returndatasize(), 0x20) { success := 0 }
            tokenBalance := mload(pointer)
        }
    }

    function _safeTransfer(address token, address recipient, uint256 amount)
        private
    {
        if (token.code.length == 0) revert InvalidContract();
        bool success;
        assembly ("memory-safe") {
            let pointer := mload(0x40)
            mstore(pointer, shl(224, 0xa9059cbb))
            mstore(add(pointer, 0x04), recipient)
            mstore(add(pointer, 0x24), amount)
            success := call(gas(), token, 0, pointer, 0x44, pointer, 0x20)
            if success {
                let size := returndatasize()
                if size {
                    success := and(gt(size, 0x1f), eq(mload(pointer), 1))
                }
            }
        }
        if (!success) revert TransferFailed();
    }

    function _tryApprove(address token, address spender, uint256 amount)
        private
        returns (bool)
    {
        if (token.code.length == 0) return false;
        if (!_callApprove(token, spender, 0)) return false;
        return amount == 0 || _callApprove(token, spender, amount);
    }

    function _callApprove(address token, address spender, uint256 amount)
        private
        returns (bool)
    {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20.approve, (spender, amount))
        );
        return success &&
            (data.length == 0 ||
                (data.length >= 32 && abi.decode(data, (bool))));
    }

    function _requireNftOwner(address manager, uint256 tokenId, address user)
        private
        view
    {
        if (
            manager != address(v3PositionManager) &&
            manager != address(v4PositionManager)
        ) revert UnsupportedManager();
        if (IERC721Manager(manager).ownerOf(tokenId) != user) revert NotOwner();
    }
}
