# Audit scope

This file defines the SCOPL V2 Robinhood Chain production review boundary. An
audit should pin a specific Git commit and report that commit in its final
deliverable.

## Start here

Requirements: Node.js 22.12 or newer and npm.

```bash
npm ci
npm run check
npm run check:dependencies
npm run check:production
npm run check:blockscout
```

Compilation uses Solidity 0.8.26, IR compilation, the optimizer enabled, and
200 optimizer runs. `npm run check` regenerates the committed ABI, bytecode,
and standard-input artifacts before running type checks and all tests.

## Deployed V2 scope

| Contract | Address | Deployment status |
| --- | --- | --- |
| `ScoplFeeRouter` | `0x7d3ea31b89804d7Dd755781d56eab7128A8b4D48` | Reused |
| `ScoplZapRouter` | `0x34BE29754d2538B31B556A7d2253a98917468c49` | Reused |
| `ScoplReferralRewards` | `0x27f1944b9C2d104446CF25aEA01510A27870f609` | V2 deployment |
| `ScoplRevenueDistributor` | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` | V2 deployment |
| `ScoplOrderPolicy` | `0xfA7a06b158eCf40232A4e1c976160be592391646` | V2 deployment |
| `ScoplLimitOrderManager` | `0x5EC1c168fD1C17d914094Dc4e96a49C9bc6d7abc` | V2 deployment |
| `ScoplV4LimitOrderManager` | `0x6f657f5E83f8469E4b04488f2be7Cec5705BaD1A` | V2 deployment |
| `ScoplBuybackVault` | `0x885C479cD30d02f7a7a09dC785b577B23ee27a00` | Reused |
| `ScoplRouterSwapAdapter` | `0x168567e09A4835D80589BCDE3F1dA5c930D5d9e7` | Reused |

The SCOPL token and Uniswap, Permit2, Pons V2, and reviewed V4 hook contracts
are external dependencies, not SCOPL source-code scope. Their addresses and
pinned runtime hashes are checked by the repository tooling.

`ScoplRevenueCollector` is source-only scope for future non-canonical-chain
deployments. It is not deployed or active on Robinhood Chain.

Test mocks under `contracts/test/`, scripts, and the web application are not
production bytecode. Scripts remain relevant to deployment verification and
privileged-operation review.

## Source of truth

- `contracts/*.sol`: production Solidity source.
- `contracts/artifacts/`: deterministic compiler output and standard input.
- `EVENTS.md`: deployed event semantics and event-only reconstruction limits.
- `deployments/order-foundation-v2-4663.json`: V2 rewards, distributor, and policy deployments.
- `deployments/limit-orders-v2-4663.json`: V2 V3 manager deployment.
- `deployments/v4-limit-orders-v2-4663.json`: V2 V4 manager deployment and hook policy.
- `deployments/revenue-routing-v2-4663.json`: final single-distributor routing transactions.
- `DEPLOYMENTS.md`: concise deployment index.

Manifests without `v2` in the filename are retained as historical evidence.
Mutable current configuration must be verified on-chain with
`npm run check:production`; a constructor-time value in an older manifest is
not evidence of current routing.

## Privileged roles

The current owner and guardian are
`0x7F4a8ff98B2b2996dC96D95A358Ecf9f7473b397`. The intended ownership Safe is
`0x8240bce5CaC6241C7B5ad3D2Ac4941e5d1014517`.

Review these privileged surfaces:

- FeeRouter fees, discounts, distributor, pause, recovery, and ownership.
- Distributor destinations, revenue sources, collector, pause, recovery,
  guardian, and ownership.
- Rewards creditors, binders, referrer approvals, and ownership.
- Policy managers, referral contract, tier signer, and ownership. Integration
  owners separately control their own recipient and trader share.
- Manager distributor, reserves, hook policy for V4, pause states, and
  ownership. Each payout recipient controls its own ETH or WETH preference.
- Buyback executors, adapters, reward, pause, recovery, guardian, and ownership.
- Zap recovery and ownership.

The swap adapter has immutable dependencies and no owner.

## Security properties and trust assumptions

- User LP NFTs remain non-custodial. Router actions require current ownership
  and explicit NFT approval.
- Direct-order economics are resolved and stored at creation. Shares always
  total 100%, and the protocol share cannot fall below 25%.
- Integration orders always allocate exactly 25% to SCOPL and never receive a
  referral allocation.
- All new Robinhood Chain revenue uses one V2 distributor: product 0 for LP
  claims, product 1 for V3 orders, and product 2 for V4 orders.
- V4 hook approval pins the runtime code hash and hook-data hash. Approved
  hooks are assumed immutable and non-proxy.
- External token, Uniswap, Permit2, Pons V2, RPC, and keeper behavior remains
  outside SCOPL's control.
- Administrative keys can change mutable configuration within the limits in
  each contract. Ownership migration tooling targets the intended Safe.

## Known and intentional limitations

- V1 contracts are outside the V2 audit scope and remain only for historical
  settlement and reward claims.
- V1 referral bindings and reward balances are not migrated. Existing V1
  balances remain claimable from the V1 rewards contract.
- A wallet bound only in V1 is not automatically attributed for new V2 LP
  revenue until it binds in V2. LP fee collection itself remains functional.
- `ScoplRevenueCollector` relay configuration is intentionally disabled until
  an official provider is selected.
- Source verification on Blockscout is an explorer service check. Temporary
  explorer errors do not supersede exact creation-input and runtime-hash checks.

This repository is prepared for independent review but does not claim that an
independent audit has already been completed.
