# SCOPL contracts

Standalone Solidity sources, tests, compiler artifacts, deployment manifests,
and administration scripts for SCOPL. This repository does not run the web
application, indexer, database, or keeper.

The exact production audit boundary, privileged roles, trust assumptions, and
known limitations are in [`AUDIT_SCOPE.md`](AUDIT_SCOPE.md).
Deployed event meanings and compatibility fields are documented in
[`EVENTS.md`](EVENTS.md).

Status: Robinhood Chain mainnet canary. The source and deployed bytecode are
verified, but this is not a claim of an independent professional audit.

## Install and test

Requirements: Node.js 22.12+ and npm.

```bash
npm ci
npm run check
```

`npm run check` compiles with Solidity 0.8.26, type-checks the test harness,
and runs all 140 tests on local Anvil chains.

Read-only live checks:

```bash
npm run check:dependencies
npm run check:production
npm run check:blockscout
npm run check:v2:foundation
npm run check:v2:managers
```

These checks use the committed deployment manifests by default. A local
`.env` is optional and can override addresses without changing the manifests.

Optional reviewed-hook fork checks:

```bash
npm run check:hooks:pons
npm run check:hooks:long
```

## SCOPL V2 production set

Chain: Robinhood Chain (`4663`). Explorer:
<https://robinhoodchain.blockscout.com>.

These are the only contracts used for new V2 activity. "Reused" means the
same live contract was retained because its bytecode already matches V2.

| Contract | Address | Status |
| --- | --- | --- |
| SCOPL token | `0xaA40e79E987517f7462bF79315B8A118799B04E3` | Existing token |
| `ScoplFeeRouter` | `0x7d3ea31b89804d7Dd755781d56eab7128A8b4D48` | Reused |
| `ScoplZapRouter` | `0x34BE29754d2538B31B556A7d2253a98917468c49` | Reused |
| `ScoplReferralRewards` | `0x27f1944b9C2d104446CF25aEA01510A27870f609` | V2 deployment |
| `ScoplRevenueDistributor` | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` | V2 deployment |
| `ScoplOrderPolicy` | `0xfA7a06b158eCf40232A4e1c976160be592391646` | V2 deployment |
| `ScoplLimitOrderManager` (V3) | `0x5EC1c168fD1C17d914094Dc4e96a49C9bc6d7abc` | V2 deployment |
| `ScoplV4LimitOrderManager` | `0x6f657f5E83f8469E4b04488f2be7Cec5705BaD1A` | V2 deployment |
| `ScoplBuybackVault` | `0x885C479cD30d02f7a7a09dC785b577B23ee27a00` | Reused |
| `ScoplRouterSwapAdapter` | `0x168567e09A4835D80589BCDE3F1dA5c930D5d9e7` | Reused |

V2 uses one `ScoplRevenueDistributor`. FeeRouter revenue is product 0, V3
order revenue is product 1, and V4 order revenue is product 2. The final
routing was activated on August 25, 2026 and is recorded in
`deployments/revenue-routing-v2-4663.json`. Verify the current live state with:

```bash
npm run activate:v2:revenue:check
npm run check:production
```

The activation command remains available for recovery and is idempotent. It
broadcasts only missing configuration. The production check fails unless every
V2 source uses the single V2 distributor.

Administration accounts:

| Role | Address |
| --- | --- |
| Current owner and guardian | `0x7F4a8ff98B2b2996dC96D95A358Ecf9f7473b397` |
| Operational treasury | `0x35396e0f6Ffb1351111Ae34001AF04Aa6C6Aa562` |
| Intended ownership Safe | `0x8240bce5CaC6241C7B5ad3D2Ac4941e5d1014517` |

`ScoplRevenueCollector` is included for non-canonical-chain deployments and is
not deployed on Robinhood Chain.

## V1 settlement and claims only

These contracts are not part of the V2 production set. They remain available
only to settle existing V1 orders and let users claim rewards already held by
the V1 rewards contract. No V1 asset or liability is moved into V2.

| Contract | Address |
| --- | --- |
| V1 `ScoplReferralRewards` | `0x4eE310BCB577afB4beEcDA9422764B7A8E4e04a3` |
| V1 `ScoplRevenueDistributor` | `0x0A552810F73892216Ae755A027D4AD3efdE3Ca87` |
| V1 V3 limit-order manager | `0xf4badBc5bea19E94f61084172f7b68383166CDd7` |
| V1 V4 limit-order manager | `0xcdD1E3BC873e5Ff7cA974b7212D6031fe853Cd42` |

V1 rewards remain claimable through <https://v1.scopl.live/referrals>. A V1
referral relationship can be read with `referrerOf(wallet)`, but the mapping
cannot be enumerated globally. The V2 application therefore copies the
relationship lazily on the wallet's first V2 direct order. The V2
`ScoplOrderPolicy` performs the binding. Reward balances are never copied.

## External dependencies and reviewed hooks

| Dependency | Address |
| --- | --- |
| V3 factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| V3 position manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| V3 swap router | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| V4 position manager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| V4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| WETH | `0x0Bd7D308f8E1639FAb988DF18A8011f41EAcAD73` |
| Pons V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Allowed Pons V2 hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| Allowed Long.xyz Doppler hook | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` |
| Reviewed Long.xyz Rehype dependency | `0x6f02324d20CC679d0E585290CAa6b16baCbC0F77` |

The dependency check pins runtime bytecode hashes, not only addresses. Exact
deployment blocks, transaction hashes, constructor arguments, hook policies,
and runtime hashes are in `deployments/` and `DEPLOYMENTS.md`.

## Deployment and administration

```bash
cp .env.example .env
```

Fill only the required values. Never commit `.env`, private keys, paid RPC
URLs, or Safe transaction batches. Prefer the scripts' hidden private-key
prompt. Always run the matching `:check` command before a mutating deployment
or activation command.

Useful commands are listed under `scripts` in `package.json`. Security reports
must follow `SECURITY.md`.
