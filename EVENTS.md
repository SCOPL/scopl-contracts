# Event semantics

This reference documents the event conventions that are not obvious from the
ABI alone. All token amount fields use raw token units. Consumers must resolve
token decimals separately.

## V2 limit-order managers

`ScoplLimitOrderManager` and `ScoplV4LimitOrderManager` use the same accounting
events.

- `OrderCreated` records the amount actually placed into the position after any
  unused input refund, plus the separate native gas reserve.
- `OrderEconomicsStored` records the immutable fee recipients and shares used
  for that order.
- Each nonzero LP-fee asset produces one `OrderFeeShareSettled` event. Its
  accounting identity is:

  ```text
  generatedFee = beneficiaryAmount + integratorAmount + protocolAmount
  ```

- `OrderFeeShareSettled.protocolAmount` is the authoritative per-token V2
  protocol fee. `beneficiaryAmount` is the user or configured beneficiary
  share. The distributor subsequently divides `protocolAmount` between
  referral, buyback, and Operations.
- `OrderExecuted.protocolFee` is a deprecated compatibility field and is
  always zero. V2 charges no fee against order principal, and a single scalar
  cannot represent protocol LP-fee shares collected in two different tokens.
  Indexers and accounting systems must not use this field for V2 revenue.
- `OrderExecuted.amountOut` is output principal. Its `amountToken0` and
  `amountToken1` fields are gross position collections, including LP fees.
  `OrderCancelled.amountToken0` and `amountToken1` are principal only. Fee
  amounts for both paths remain exclusively in `OrderFeeShareSettled`.
- A V4 native-currency settlement uses `address(0)` in
  `OrderFeeShareSettled`. The distributor wraps that amount and therefore
  emits WETH as the token in `RevenueDistributed`.

## Revenue and referrals

- `ScoplRevenueDistributor.RevenueDistributed` is the final protocol split and
  satisfies `grossAmount = referralAmount + buybackAmount + operationalAmount`.
- If referral credit fails, `ReferralCreditFailed` records the attempted
  amount. The following `RevenueDistributed` retains the attributed referrer,
  reports `referralAmount` as zero, and includes the failed amount in
  `operationalAmount`.
- `ScoplReferralRewards.RewardAccrued` and `RewardsClaimed` report exact token
  liabilities by revenue source. A claim total is the sum of its LP-claim and
  limit-order fields.
- `ScoplFeeRouter.FeesClaimed` reports gross collected amounts and the exact
  protocol fee for each token. `FeeCharged` repeats each nonzero protocol fee
  with the effective basis-point rate.

## Zap, buyback, and cross-chain events

- The deployed `ScoplZapRouter.PositionZapped.tokenIn` ABI name refers to the
  caller's `sourceToken`. When a preparation route is used, `amountIn` is in
  source-token units while `swapAmountIn` is in prepared pool-input units.
- `V4PositionMinted.amount0Budget` and `amount1Budget` are pre-mint maximum
  budgets, not the amounts consumed. Canonical PositionManager events provide
  the actual mint transfers.
- `ScoplBuybackVault` execution events report measured balance deltas and the
  keeper reward actually paid. `PonsCurveBuyExecuted.quoteIn - quoteSpent` is
  the quote refund.
- `ScoplRevenueCollector.RevenueSweepSubmitted` means the immutable
  destination transfer was submitted to the approved provider. Confirmation
  on the destination chain is a separate transport-layer fact.
- `ScoplRouterSwapAdapter` deliberately emits no event. Its controller measures
  exact input and output balance deltas and emits the protocol-level
  normalization or buyback event.

## Event-only reconstruction limitations

- The reused `ScoplFeeRouter` constructor did not emit initial ownership,
  distributor, or default fee-configuration events. Verify its creation input
  and current getters instead of reconstructing initial state from logs alone.
- The V4 manager constructor emits `HookPermissionUpdated(address(0), true)`
  for hookless pools but not the richer `HookPolicyUpdated` event. Its hookless
  data hash is available from `allowedHookDataHash(address(0))` and the
  deployment manifest.
- `ScoplRevenueCollector` is source-only and not deployed. Its current
  `recoverExcess` administrative path has no dedicated event. Add an explicit
  recovery event before any future deployment of that contract.
