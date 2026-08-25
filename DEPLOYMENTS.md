# Robinhood Chain deployments

Chain ID: `4663`. Explorer: <https://robinhoodchain.blockscout.com>.

## SCOPL V2 order system

| Contract | Address | Deployment block |
| --- | --- | ---: |
| `ScoplReferralRewards` | `0x27f1944b9C2d104446CF25aEA01510A27870f609` | 45,857,979 |
| `ScoplRevenueDistributor` | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` | 45,858,025 |
| `ScoplOrderPolicy` | `0xfA7a06b158eCf40232A4e1c976160be592391646` | 45,858,071 |
| `ScoplLimitOrderManager` | `0x5EC1c168fD1C17d914094Dc4e96a49C9bc6d7abc` | 45,890,286 |
| `ScoplV4LimitOrderManager` | `0x6f657f5E83f8469E4b04488f2be7Cec5705BaD1A` | 45,895,231 |

The two managers are authorized in the policy and as revenue products 1 and 2
respectively. Hookless V4 pools and the bytecode-pinned Pons V2 and Long.xyz
hooks were enabled during deployment. Exact transaction hashes, constructor
arguments, runtime hashes, dependencies, and hook policies are recorded in
the corresponding JSON manifests under `deployments/`.

The V2 target has one distributor for all new protocol revenue:

| Product | Revenue source | Distributor |
| ---: | --- | --- |
| 0 | `ScoplFeeRouter` at `0x7d3ea31b89804d7Dd755781d56eab7128A8b4D48` | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` |
| 1 | V2 V3 manager | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` |
| 2 | V2 V4 manager | `0x1cfB6dC47b7F2Ac83939Ba863AE41E7041414F13` |

The routing was activated on August 25, 2026. Transaction hashes and blocks are
recorded in `deployments/revenue-routing-v2-4663.json`. Run
`npm run activate:v2:revenue:check` and `npm run check:production` to verify the
current state. The mutating activation command is retained as an idempotent
recovery tool.

## V1 settlement and claims only

The V1 V3 manager `0xf4badBc5bea19E94f61084172f7b68383166CDd7`
and V1 V4 manager `0xcdD1E3BC873e5Ff7cA974b7212D6031fe853Cd42`
remain recorded because existing positions may still require settlement. The
V1 rewards contract `0x4eE310BCB577afB4beEcDA9422764B7A8E4e04a3`
continues to hold V1 reward balances. Users claim those balances through
<https://v1.scopl.live/referrals>. V1 contracts are excluded from V2 ownership
tooling and new V2 writes.

The non-V2 manifests are retained as immutable historical evidence. In
particular, `pons-buyback-4663.json` records the distributor that existed when
the reused vault was configured. That historical field is not the V2 revenue
route. `order-foundation-v2-4663.json` and
`revenue-routing-v2-4663.json` are the V2 sources of truth.

## Existing protocol infrastructure

| Contract | Address |
| --- | --- |
| `ScoplFeeRouter` | `0x7d3ea31b89804d7Dd755781d56eab7128A8b4D48` |
| `ScoplZapRouter` | `0x34BE29754d2538B31B556A7d2253a98917468c49` |
| `ScoplBuybackVault` | `0x885C479cD30d02f7a7a09dC785b577B23ee27a00` |
| `ScoplRouterSwapAdapter` | `0x168567e09A4835D80589BCDE3F1dA5c930D5d9e7` |

Addresses are facts, not endorsements. Verify the chain ID, source, creation
input, runtime bytecode, owner, paused state, and dependency hashes before any
interaction.
