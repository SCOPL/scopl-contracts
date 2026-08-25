# SCOPL contracts

See [`../AUDIT_SCOPE.md`](../AUDIT_SCOPE.md) for the exact deployed audit scope,
privileged operations, trust assumptions, and known limitations.
See [`../EVENTS.md`](../EVENTS.md) before building an indexer or reconstructing
accounting from logs.

## SCOPL V2 limit orders

`ScoplOrderPolicy` is the canonical shared economics and attribution layer for both `ScoplLimitOrderManager` (V3 pools) and `ScoplV4LimitOrderManager` (V4 pools).

- Direct orders store the owner as beneficiary and a 10/90, 25/75, 50/50, or 75/25 user/protocol LP-fee split.
- Robinhood Chain reads the canonical SCOPL balance at creation. Other chains verify an optional EIP-712 tier attestation and safely fall back to 10/90 when none is supplied.
- Integration registration is permissionless. Its owner configures a trader share from 0% to 75%; the integrator receives the remainder of 75%, SCOPL receives exactly 25%, and the referrer is always zero.
- A valid direct referrer may be permanently bound through `ScoplReferralRewards.bindReferrerFor` in the same create transaction.
- The direct tier thresholds and shares are hardcoded and cannot be changed by governance.
- Native proceeds default to ETH. Each recipient can opt into WETH on either manager, and failed native delivery falls back to WETH.

Managers store the resolved user share, integrator share, integrator recipient, protocol share, and referrer with every order. At execution or cancellation all principal goes to the owner, while generated LP fees are divided exactly once. The protocol share never falls below 25%; all effective shares always total 100%.

Legacy deployed managers are not upgraded. Application configuration retains them only for reading and managing existing positions.

## Revenue

`ScoplRevenueDistributor` keeps the existing protocol allocation: 30% referral, 50% buyback, and 20% Operations. With an explicitly attributed zero referrer, the referral share moves to Operations. Only the buyback portion may be deposited into an optional `ScoplRevenueCollector`.

Each non-canonical-chain collector accepts exact deposits only from approved protocol revenue sources. Approved, codehash-pinned, non-proxy adapters may normalize accounted assets to WETH. An approved executor and codehash-pinned, non-proxy transport contract can sweep an exact, unique WETH amount only to the immutable canonical destination chain and vault. The collector never receives or controls order principal, user shares, integration shares, referral balances, or Operations balances.

Custom V4 hooks remain supported. Governance approval pins the hook's current runtime bytecode and hook-data hash. Production hook addresses must be immutable, non-proxy contracts; a proxy implementation upgrade cannot be detected with `EXTCODEHASH`. Users always retain direct PositionManager control through the official Uniswap interface.

Relay is not hardcoded. Keeper code defines a small replaceable provider boundary and remains disabled until official provider configuration is supplied.

## Other protocol surfaces

`ScoplFeeRouter` applies the separate LP-management claim policy. `ScoplZapRouter`, `ScoplBuybackVault`, and pinned swap adapters retain their existing responsibilities.

## Verification

```bash
npm run compile
npm test
npm run typecheck
```

Compilation and tests are not substitutes for an independent production audit.
