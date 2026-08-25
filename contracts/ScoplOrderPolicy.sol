// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplPolicyToken {
    function balanceOf(address account) external view returns (uint256);
}

interface IScoplPolicyReferralRewards {
    function referrerOf(address referred) external view returns (address);
    function bindReferrerFor(address referred, address referrer) external;
}

/// @notice Canonical order-attribution and LP-fee beneficiary policy shared by
///         every SCOPL V2 V3/V4 order manager on one deployment.
/// @dev This contract can only select fee beneficiaries. It never receives
///      principal, owns positions, executes orders, or withdraws user assets.
contract ScoplOrderPolicy {
    error ExpiredAttestation();
    error InvalidAttestation();
    error InvalidConfiguration();
    error InvalidContract();
    error InvalidRecipient();
    error IntegrationAlreadyRegistered();
    error NotManager();
    error NotIntegrationOwner();
    error NotOwner();
    error NotPendingIntegrationOwner();
    error NotPendingOwner();
    error UnsupportedIntegration();
    error UnsupportedTier();

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant PROTOCOL_SHARE_BPS = 2_500;
    uint16 public constant MIN_PROTOCOL_SHARE_BPS = PROTOCOL_SHARE_BPS;
    uint16 public constant MAX_BENEFICIARY_SHARE_BPS = 7_500;
    uint16 public constant MAX_INTEGRATION_USER_SHARE_BPS = 7_500;
    uint256 public constant TIER_ONE_MINIMUM_BALANCE = 50_000 ether;
    uint256 public constant TIER_TWO_MINIMUM_BALANCE = 250_000 ether;
    uint256 public constant TIER_THREE_MINIMUM_BALANCE = 1_000_000 ether;
    uint16 public constant TIER_ZERO_USER_SHARE_BPS = 1_000;
    uint16 public constant TIER_ONE_USER_SHARE_BPS = 2_500;
    uint16 public constant TIER_TWO_USER_SHARE_BPS = 5_000;
    uint16 public constant TIER_THREE_USER_SHARE_BPS = 7_500;
    bytes32 public constant TIER_ATTESTATION_TYPEHASH = keccak256(
        "TierAttestation(address user,uint256 destinationChainId,uint16 beneficiaryShareBps,uint48 expiry)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("SCOPL Order Policy");
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

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

    struct Integration {
        address owner;
        address feeRecipient;
        uint16 userShareBps;
    }

    event ManagerPermissionUpdated(address indexed manager, bool allowed);
    event IntegrationRegistered(
        bytes32 indexed integrationId,
        address indexed owner,
        address indexed feeRecipient,
        uint16 userShareBps
    );
    event IntegrationUpdated(
        bytes32 indexed integrationId,
        address indexed feeRecipient,
        uint16 userShareBps
    );
    event IntegrationOwnershipTransferStarted(
        bytes32 indexed integrationId,
        address indexed owner,
        address indexed pendingOwner
    );
    event IntegrationOwnershipTransferred(
        bytes32 indexed integrationId,
        address indexed previousOwner,
        address indexed newOwner
    );
    event ReferralRewardsUpdated(address indexed referralRewards);
    event TierSignerUpdated(address indexed tierSigner);
    event OrderPolicyResolved(
        address indexed manager,
        address indexed user,
        OrderSource source,
        bytes32 indexed integrationId,
        address beneficiary,
        uint16 beneficiaryShareBps,
        address integratorFeeRecipient,
        uint16 integratorShareBps,
        uint16 protocolShareBps,
        address referrer
    );
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    address public referralRewards;
    address public tierSigner;
    address public immutable canonicalScoplToken;
    uint256 public immutable canonicalScoplChainId;
    uint256[3] public minimumBalances;
    uint16[4] public beneficiarySharesBps;

    mapping(address manager => bool allowed) public managers;
    mapping(bytes32 integrationId => Integration integration) public integrations;
    mapping(bytes32 integrationId => address pendingOwner)
        public pendingIntegrationOwners;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyManager() {
        if (!managers[msg.sender]) revert NotManager();
        _;
    }

    constructor(
        address initialOwner,
        address canonicalToken,
        uint256 canonicalChainId,
        address initialReferralRewards,
        address initialTierSigner,
        uint256[3] memory initialMinimumBalances,
        uint16[4] memory initialBeneficiarySharesBps
    ) {
        if (initialOwner == address(0) || canonicalToken == address(0)) {
            revert InvalidRecipient();
        }
        if (
            initialReferralRewards.code.length == 0 ||
            (block.chainid == canonicalChainId && canonicalToken.code.length == 0)
        ) revert InvalidContract();
        if (canonicalChainId == 0) revert InvalidConfiguration();
        owner = initialOwner;
        canonicalScoplToken = canonicalToken;
        canonicalScoplChainId = canonicalChainId;
        referralRewards = initialReferralRewards;
        tierSigner = initialTierSigner;
        _requireFinalTierConfiguration(
            initialMinimumBalances,
            initialBeneficiarySharesBps
        );
        minimumBalances = [
            TIER_ONE_MINIMUM_BALANCE,
            TIER_TWO_MINIMUM_BALANCE,
            TIER_THREE_MINIMUM_BALANCE
        ];
        beneficiarySharesBps = [
            TIER_ZERO_USER_SHARE_BPS,
            TIER_ONE_USER_SHARE_BPS,
            TIER_TWO_USER_SHARE_BPS,
            TIER_THREE_USER_SHARE_BPS
        ];
        emit OwnershipTransferred(address(0), initialOwner);
        emit ReferralRewardsUpdated(initialReferralRewards);
        emit TierSignerUpdated(initialTierSigner);
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

    function setManager(address manager, bool allowed) external onlyOwner {
        if (manager == address(0) || (allowed && manager.code.length == 0)) {
            revert InvalidContract();
        }
        managers[manager] = allowed;
        emit ManagerPermissionUpdated(manager, allowed);
    }

    /// @notice Returns the same logical integration ID on every SCOPL chain
    ///         when the same developer wallet and registration key are used.
    function integrationIdFor(address integrationOwner, bytes32 registrationKey)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(integrationOwner, registrationKey));
    }

    function registerIntegration(
        bytes32 registrationKey,
        address feeRecipient,
        uint16 userShareBps
    ) external returns (bytes32 integrationId) {
        _validateIntegrationConfiguration(feeRecipient, userShareBps);
        integrationId = integrationIdFor(msg.sender, registrationKey);
        if (integrations[integrationId].owner != address(0)) {
            revert IntegrationAlreadyRegistered();
        }
        integrations[integrationId] = Integration({
            owner: msg.sender,
            feeRecipient: feeRecipient,
            userShareBps: userShareBps
        });
        emit IntegrationRegistered(
            integrationId,
            msg.sender,
            feeRecipient,
            userShareBps
        );
    }

    function updateIntegration(
        bytes32 integrationId,
        address feeRecipient,
        uint16 userShareBps
    ) external {
        Integration storage integration = integrations[integrationId];
        if (integration.owner != msg.sender) revert NotIntegrationOwner();
        _validateIntegrationConfiguration(feeRecipient, userShareBps);
        integration.feeRecipient = feeRecipient;
        integration.userShareBps = userShareBps;
        emit IntegrationUpdated(integrationId, feeRecipient, userShareBps);
    }

    function transferIntegrationOwnership(
        bytes32 integrationId,
        address nextOwner
    ) external {
        Integration storage integration = integrations[integrationId];
        if (integration.owner != msg.sender) revert NotIntegrationOwner();
        if (nextOwner == address(0)) revert InvalidRecipient();
        pendingIntegrationOwners[integrationId] = nextOwner;
        emit IntegrationOwnershipTransferStarted(
            integrationId,
            msg.sender,
            nextOwner
        );
    }

    function acceptIntegrationOwnership(bytes32 integrationId) external {
        if (pendingIntegrationOwners[integrationId] != msg.sender) {
            revert NotPendingIntegrationOwner();
        }
        Integration storage integration = integrations[integrationId];
        address previousOwner = integration.owner;
        if (previousOwner == address(0)) revert UnsupportedIntegration();
        integration.owner = msg.sender;
        delete pendingIntegrationOwners[integrationId];
        emit IntegrationOwnershipTransferred(
            integrationId,
            previousOwner,
            msg.sender
        );
    }

    function setReferralRewards(address nextReferralRewards) external onlyOwner {
        if (nextReferralRewards.code.length == 0) revert InvalidContract();
        referralRewards = nextReferralRewards;
        emit ReferralRewardsUpdated(nextReferralRewards);
    }

    function setTierSigner(address nextTierSigner) external onlyOwner {
        tierSigner = nextTierSigner;
        emit TierSignerUpdated(nextTierSigner);
    }

    function tierConfiguration()
        external
        view
        returns (
            uint256[3] memory thresholds,
            uint16[4] memory shares
        )
    {
        thresholds = minimumBalances;
        shares = beneficiarySharesBps;
    }

    function beneficiaryShareForBalance(uint256 balance)
        public
        view
        returns (uint16 shareBps)
    {
        shareBps = beneficiarySharesBps[0];
        for (uint256 index = 0; index < minimumBalances.length; index++) {
            if (balance >= minimumBalances[index]) {
                shareBps = beneficiarySharesBps[index + 1];
            }
        }
    }

    /// @notice Resolves immutable order economics and lazily binds an optional
    ///         direct-order referrer. A non-zero integration ID always bypasses
    ///         both referral and tier infrastructure.
    function resolveOrderPolicy(
        address user,
        bytes32 integrationId,
        address optionalReferrer,
        TierAttestation calldata attestation,
        bytes calldata signature
    ) external onlyManager returns (ResolvedOrderPolicy memory resolved) {
        if (user == address(0)) revert InvalidRecipient();
        if (integrationId != bytes32(0)) {
            Integration memory integration = integrations[integrationId];
            if (integration.owner == address(0)) {
                revert UnsupportedIntegration();
            }
            uint16 integratorShareBps =
                MAX_INTEGRATION_USER_SHARE_BPS - integration.userShareBps;
            resolved = ResolvedOrderPolicy({
                source: OrderSource.Integration,
                integrationId: integrationId,
                beneficiary: user,
                beneficiaryShareBps: integration.userShareBps,
                integratorFeeRecipient: integration.feeRecipient,
                integratorShareBps: integratorShareBps,
                protocolShareBps: PROTOCOL_SHARE_BPS,
                referrer: address(0)
            });
        } else {
            address referrer = _resolveDirectReferrer(user, optionalReferrer);
            uint16 shareBps = _resolveDirectShare(user, attestation, signature);
            resolved = ResolvedOrderPolicy({
                source: OrderSource.Direct,
                integrationId: bytes32(0),
                beneficiary: user,
                beneficiaryShareBps: shareBps,
                integratorFeeRecipient: address(0),
                integratorShareBps: 0,
                protocolShareBps: BPS_DENOMINATOR - shareBps,
                referrer: referrer
            });
        }
        if (
            resolved.beneficiaryShareBps > MAX_BENEFICIARY_SHARE_BPS ||
            resolved.protocolShareBps < MIN_PROTOCOL_SHARE_BPS ||
            uint256(resolved.beneficiaryShareBps) +
                resolved.integratorShareBps +
                resolved.protocolShareBps != BPS_DENOMINATOR
        ) revert InvalidConfiguration();
        emit OrderPolicyResolved(
            msg.sender,
            user,
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

    function attestationDigest(TierAttestation calldata attestation)
        external
        view
        returns (bytes32)
    {
        return _attestationDigest(attestation);
    }

    function _resolveDirectShare(
        address user,
        TierAttestation calldata attestation,
        bytes calldata signature
    ) private view returns (uint16 shareBps) {
        if (block.chainid == canonicalScoplChainId) {
            return beneficiaryShareForBalance(
                IScoplPolicyToken(canonicalScoplToken).balanceOf(user)
            );
        }
        if (signature.length == 0) return TIER_ZERO_USER_SHARE_BPS;
        if (attestation.expiry < block.timestamp) revert ExpiredAttestation();
        if (
            attestation.user != user ||
            attestation.destinationChainId != block.chainid ||
            !_isSupportedShare(attestation.beneficiaryShareBps)
        ) revert InvalidAttestation();
        address signer = tierSigner;
        if (
            signer == address(0) ||
            _recover(_attestationDigest(attestation), signature) != signer
        ) revert InvalidAttestation();
        shareBps = attestation.beneficiaryShareBps;
    }

    function _resolveDirectReferrer(address user, address optionalReferrer)
        private
        returns (address referrer)
    {
        IScoplPolicyReferralRewards rewards =
            IScoplPolicyReferralRewards(referralRewards);
        referrer = rewards.referrerOf(user);
        if (
            referrer != address(0) ||
            optionalReferrer == address(0) ||
            optionalReferrer == user
        ) return referrer;
        try rewards.bindReferrerFor(user, optionalReferrer) {
            referrer = rewards.referrerOf(user);
        } catch {
            // Invalid or unapproved optional referral data must never corrupt a
            // binding or prevent the user from placing an otherwise valid order.
            referrer = address(0);
        }
    }

    function _requireFinalTierConfiguration(
        uint256[3] memory nextMinimumBalances,
        uint16[4] memory nextBeneficiarySharesBps
    ) private pure {
        if (
            nextMinimumBalances[0] != TIER_ONE_MINIMUM_BALANCE ||
            nextMinimumBalances[1] != TIER_TWO_MINIMUM_BALANCE ||
            nextMinimumBalances[2] != TIER_THREE_MINIMUM_BALANCE ||
            nextBeneficiarySharesBps[0] != TIER_ZERO_USER_SHARE_BPS ||
            nextBeneficiarySharesBps[1] != TIER_ONE_USER_SHARE_BPS ||
            nextBeneficiarySharesBps[2] != TIER_TWO_USER_SHARE_BPS ||
            nextBeneficiarySharesBps[3] != TIER_THREE_USER_SHARE_BPS
        ) revert InvalidConfiguration();
    }

    function _validateIntegrationConfiguration(
        address feeRecipient,
        uint16 userShareBps
    ) private pure {
        if (feeRecipient == address(0)) revert InvalidRecipient();
        if (userShareBps > MAX_INTEGRATION_USER_SHARE_BPS) {
            revert InvalidConfiguration();
        }
    }

    function _isSupportedShare(uint16 shareBps) private pure returns (bool) {
        return shareBps == TIER_ZERO_USER_SHARE_BPS ||
            shareBps == TIER_ONE_USER_SHARE_BPS ||
            shareBps == TIER_TWO_USER_SHARE_BPS ||
            shareBps == TIER_THREE_USER_SHARE_BPS;
    }

    function _attestationDigest(TierAttestation calldata attestation)
        private
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                TIER_ATTESTATION_TYPEHASH,
                attestation.user,
                attestation.destinationChainId,
                attestation.beneficiaryShareBps,
                attestation.expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature)
        private
        pure
        returns (address recovered)
    {
        if (signature.length != 65) revert InvalidAttestation();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_DIV_2) revert InvalidAttestation();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidAttestation();
        recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidAttestation();
    }
}
