// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPolicyUnderTest {
    struct TierAttestation {
        address user;
        uint256 destinationChainId;
        uint16 beneficiaryShareBps;
        uint48 expiry;
    }
    struct ResolvedOrderPolicy {
        uint8 source;
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

contract ScoplOrderPolicyCaller {
    function resolve(
        address policy,
        address user,
        bytes32 integrationId,
        address optionalReferrer,
        IPolicyUnderTest.TierAttestation calldata attestation,
        bytes calldata signature
    ) external returns (IPolicyUnderTest.ResolvedOrderPolicy memory resolved) {
        return IPolicyUnderTest(policy).resolveOrderPolicy(
            user,
            integrationId,
            optionalReferrer,
            attestation,
            signature
        );
    }
}
