// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplReferralToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external returns (bool);
}

/// @notice Per-token referral ledger funded only by approved SCOPL revenue
///         distributors. Rewards are never converted or valued on-chain.
contract ScoplReferralRewards {
    error AlreadyAttributed();
    error DuplicateRevenue();
    error InvalidAmount();
    error InvalidBatchSize();
    error InvalidContract();
    error InvalidRecipient();
    error NoRewards();
    error NotOwner();
    error NotPendingOwner();
    error NotReferralBinder();
    error NotRevenueCreditor();
    error ReferrerNotApproved();
    error ReentrantCall();
    error SelfReferral();
    error TransferFailed();

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant referralShareBps = 3_000;
    uint256 public constant MAX_CLAIM_TOKENS = 64;
    uint256 public constant MAX_PAGE_SIZE = 200;
    uint256 public constant MAX_REFERRER_APPROVAL_BATCH = 100;

    enum RevenueSource {
        LpClaim,
        LimitOrder
    }

    struct RewardBalance {
        uint256 lpClaimAccrued;
        uint256 limitOrderAccrued;
        uint256 lpClaimClaimed;
        uint256 limitOrderClaimed;
    }

    event ReferralBound(address indexed referred, address indexed referrer);
    event RewardAccrued(
        address indexed referrer,
        address indexed referred,
        address indexed token,
        uint256 amount,
        RevenueSource source,
        bytes32 revenueId
    );
    event RewardsClaimed(
        address indexed referrer,
        address indexed token,
        uint256 lpClaimAmount,
        uint256 limitOrderAmount
    );
    event RevenueCreditorPermissionUpdated(address indexed creditor, bool allowed);
    event ReferralBinderPermissionUpdated(address indexed binder, bool allowed);
    event ReferrerApprovalRequirementUpdated(bool required);
    event ReferrerApprovalUpdated(address indexed referrer, bool approved);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    bool public referrerApprovalRequired;
    uint256 private reentrancyState = 1;

    mapping(address referred => address referrer) public referrerOf;
    mapping(address creditor => bool allowed) public revenueCreditors;
    mapping(address binder => bool allowed) public referralBinders;
    mapping(address referrer => bool approved) public approvedReferrers;
    mapping(address referrer => uint256 count) public referredCount;
    mapping(address referrer => mapping(address token => RewardBalance)) public rewards;
    mapping(address token => uint256 amount) public totalLiability;
    mapping(bytes32 revenueId => bool processed) public processedRevenue;
    mapping(address referrer => address[] tokens) private rewardTokens;
    mapping(address referrer => mapping(address token => bool seen)) private rewardTokenSeen;

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

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidRecipient();
        owner = initialOwner;
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

    function setRevenueCreditorAllowed(address creditor, bool allowed)
        external onlyOwner
    {
        if (creditor == address(0)) revert InvalidRecipient();
        if (allowed && creditor.code.length == 0) revert InvalidContract();
        revenueCreditors[creditor] = allowed;
        emit RevenueCreditorPermissionUpdated(creditor, allowed);
    }

    /// @notice Authorizes a SCOPL order-policy contract to bind referrals as
    ///         part of the same transaction that creates a direct order.
    function setReferralBinderAllowed(address binder, bool allowed)
        external onlyOwner
    {
        if (binder == address(0)) revert InvalidRecipient();
        if (allowed && binder.code.length == 0) revert InvalidContract();
        referralBinders[binder] = allowed;
        emit ReferralBinderPermissionUpdated(binder, allowed);
    }

    function setReferrerApprovalRequired(bool required) external onlyOwner {
        referrerApprovalRequired = required;
        emit ReferrerApprovalRequirementUpdated(required);
    }

    function setReferrerApprovals(address[] calldata referrers, bool approved)
        external onlyOwner
    {
        if (
            referrers.length == 0 ||
            referrers.length > MAX_REFERRER_APPROVAL_BATCH
        ) revert InvalidBatchSize();
        for (uint256 index = 0; index < referrers.length; index++) {
            address referrer = referrers[index];
            if (referrer == address(0)) revert InvalidRecipient();
            approvedReferrers[referrer] = approved;
            emit ReferrerApprovalUpdated(referrer, approved);
        }
    }

    function bindReferrer(address referrer) external {
        _bindReferrer(msg.sender, referrer);
    }

    /// @notice Atomic order-creation binding path. Existing bindings retain
    ///         their original referrer and cannot be overwritten.
    function bindReferrerFor(address referred, address referrer) external {
        if (!referralBinders[msg.sender]) revert NotReferralBinder();
        _bindReferrer(referred, referrer);
    }

    function _bindReferrer(address referred, address referrer) private {
        if (referred == address(0)) revert InvalidRecipient();
        if (referrer == address(0)) revert InvalidRecipient();
        if (referrer == referred) revert SelfReferral();
        if (referrerApprovalRequired && !approvedReferrers[referrer]) {
            revert ReferrerNotApproved();
        }
        if (referrerOf[referred] != address(0)) revert AlreadyAttributed();
        referrerOf[referred] = referrer;
        referredCount[referrer] += 1;
        emit ReferralBound(referred, referrer);
    }

    /// @notice Pulls an exact reward amount in its original fee token.
    function creditReward(
        bytes32 revenueId,
        address referrer,
        address referred,
        address token,
        uint256 rewardAmount,
        RevenueSource source
    ) external nonReentrant {
        if (!revenueCreditors[msg.sender]) revert NotRevenueCreditor();
        if (revenueId == bytes32(0) || processedRevenue[revenueId]) {
            revert DuplicateRevenue();
        }
        if (referrer == address(0) || referred == address(0)) {
            revert InvalidRecipient();
        }
        if (token.code.length == 0) revert InvalidContract();
        if (rewardAmount == 0) revert InvalidAmount();

        processedRevenue[revenueId] = true;
        uint256 beforeBalance = IScoplReferralToken(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), rewardAmount);
        if (
            IScoplReferralToken(token).balanceOf(address(this)) - beforeBalance !=
            rewardAmount
        ) revert TransferFailed();

        totalLiability[token] += rewardAmount;
        _touchRewardToken(referrer, token);
        RewardBalance storage reward = rewards[referrer][token];
        if (source == RevenueSource.LpClaim) {
            reward.lpClaimAccrued += rewardAmount;
        } else {
            reward.limitOrderAccrued += rewardAmount;
        }
        emit RewardAccrued(
            referrer,
            referred,
            token,
            rewardAmount,
            source,
            revenueId
        );
    }

    function claimable(address referrer, address token)
        public view returns (
            uint256 lpClaimAmount,
            uint256 limitOrderAmount,
            uint256 totalAmount
        )
    {
        RewardBalance storage balance = rewards[referrer][token];
        lpClaimAmount = balance.lpClaimAccrued - balance.lpClaimClaimed;
        limitOrderAmount = balance.limitOrderAccrued - balance.limitOrderClaimed;
        totalAmount = lpClaimAmount + limitOrderAmount;
    }

    function getRewardTokens(address referrer)
        external view returns (address[] memory)
    {
        return rewardTokens[referrer];
    }

    function getRewardTokenCount(address referrer) external view returns (uint256) {
        return rewardTokens[referrer].length;
    }

    function getRewardTokensPage(address referrer, uint256 offset, uint256 limit)
        external view returns (address[] memory page)
    {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidBatchSize();
        uint256 length = rewardTokens[referrer].length;
        if (offset >= length) return new address[](0);
        uint256 end = offset + limit;
        if (end > length) end = length;
        page = new address[](end - offset);
        for (uint256 index = offset; index < end; index++) {
            page[index - offset] = rewardTokens[referrer][index];
        }
    }

    function claim(address token) external nonReentrant returns (uint256 amount) {
        return _claim(msg.sender, token);
    }

    function claimAll(address[] calldata tokens)
        external nonReentrant returns (uint256 totalAmount)
    {
        if (tokens.length == 0 || tokens.length > MAX_CLAIM_TOKENS) {
            revert InvalidBatchSize();
        }
        for (uint256 index = 0; index < tokens.length; index++) {
            (, , uint256 currentAmount) = claimable(msg.sender, tokens[index]);
            if (currentAmount > 0) totalAmount += _claim(msg.sender, tokens[index]);
        }
        if (totalAmount == 0) revert NoRewards();
    }

    function _claim(address referrer, address token) private returns (uint256 amount) {
        (
            uint256 lpClaimAmount,
            uint256 limitOrderAmount,
            uint256 totalAmount
        ) = claimable(referrer, token);
        if (totalAmount == 0) revert NoRewards();
        RewardBalance storage balance = rewards[referrer][token];
        balance.lpClaimClaimed += lpClaimAmount;
        balance.limitOrderClaimed += limitOrderAmount;
        totalLiability[token] -= totalAmount;
        _safeTransfer(token, referrer, totalAmount);
        emit RewardsClaimed(referrer, token, lpClaimAmount, limitOrderAmount);
        return totalAmount;
    }

    function _touchRewardToken(address referrer, address token) private {
        if (rewardTokenSeen[referrer][token]) return;
        rewardTokenSeen[referrer][token] = true;
        rewardTokens[referrer].push(token);
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IScoplReferralToken.transfer, (recipient, amount))
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
                IScoplReferralToken.transferFrom,
                (sender, recipient, amount)
            )
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
