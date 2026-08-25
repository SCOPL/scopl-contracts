# Revert Contract Review

This review records which Revert Finance patterns informed
`ScoplFeeRouter.sol` and `ScoplZapRouter.sol`, and which patterns are
deliberately not copied.

## Sources reviewed

- Revert contract addresses:
  https://docs.revert.finance/revert/resources/contract-addresses
- Revert security and audit index:
  https://docs.revert.finance/revert/resources/security
- Audited V3Utils contest source:
  https://github.com/code-423n4/2024-03-revert-lend
- Revert's V3Utils incident report:
  https://paragraph.com/@revertfinance/an-attack-on-v3utils
- Revert's V3Utils relaunch summary:
  https://paragraph.com/@revertfinance/v3utils-is-back
- Revert V3Utils v1.1 `swapAndMint` source and ABI:
  https://github.com/code-423n4/2024-03-revert-lend/blob/main/src/transformers/V3Utils.sol
- Revert V4Utils deployments and audit index:
  https://docs.revert.finance/revert/resources/contract-addresses
  https://docs.revert.finance/revert/resources/security

The reviewed V3Utils source is licensed under BUSL-1.1. SCOPL is MIT licensed,
so SCOPL does not reproduce that implementation. The patterns below are
independently implemented against SCOPL's smaller claim-and-remove scope.

## Patterns retained

- The position NFT remains in the user's wallet.
- Every position operation verifies the current NFT owner.
- Collected amounts are measured with contract balance deltas.
- Native currency is accepted only from explicitly trusted contracts.
- WETH unwrapping and native transfer failures revert atomically.
- Untrusted token callbacks cannot reenter position actions.
- Manager and WETH addresses are immutable deployment dependencies.
- Fee and principal movements use separate accounting and events.
- Configuration values have hard upper bounds and explicit validation.

## Additional SCOPL hardening

- SCOPL exposes no generic external-call or arbitrary swap-calldata execution.
- NFT approval cannot be used by another account because every action checks
  both `msg.sender` and the live NFT owner.
- The entire SCOPL balance discount schedule can be changed atomically with
  `setFeeSchedule`, avoiding a partially updated configuration.
- The SCOPL token `balanceOf` call has a fixed gas allowance. A broken or
  adversarial future token falls back to the base fee instead of blocking LP
  claims and removals.
- ERC-20 payouts reject addresses without deployed contract code.
- The protocol fee has an immutable 5% ceiling.

## Zap patterns retained

- Swap output and liquidity contribution minimums are explicit caller inputs.
- The position NFT is minted directly to the user's address.
- Unused pool assets are returned in the same transaction.
- Input may be either pool asset or a separately prepared source asset.
- Permit2 approvals are exact, time-bounded, and issued only for non-zero v4
  contributions.
- Pre-existing router balances are excluded from both liquidity contribution
  and refund accounting.
- Every protocol dependency is immutable and its runtime code hash is pinned by
  the production preflight.
- Behavioral EVM tests cover v3/v4 success, preparation, slippage rollback,
  one-sided liquidity, refunds, and pre-existing balances.

## Patterns deliberately excluded

- **Arbitrary swap targets and calldata.** Revert's 2023 V3Utils incident used
  a caller-controlled swap target to execute arbitrary calls from an approved
  contract. SCOPL routing remains in dedicated, fixed-protocol frontend flows.
- **Generic instruction execution.** SCOPL exposes typed v3/v4 claim and remove
  functions rather than a broad instruction interpreter.
- **Automator operators.** SCOPL currently has no keeper or bot role that can
  act on a user's position.
- **Vault custody and lending.** Revert Lend owns deposited NFTs and has a much
  larger oracle, liquidation, and accounting surface. It is not applicable to
  SCOPL's non-custodial fee router.
- **Temporary NFT transfer callbacks.** This can make a complex series of
  actions atomic, but adds ERC-721 receiver and return-path risk. SCOPL's
  narrower operations use per-position approval while ownership stays with
  the user.
- **Source-code copying.** The reviewed V3Utils v1.1 source is BUSL-1.1 while
  SCOPL is MIT. SCOPL independently implements only the compatible security
  properties and does not reproduce the implementation.

## Remaining production-promotion requirements

Reusing audited ideas does not transfer an audit to SCOPL. Before promoting the
mainnet canary to general availability, rerun Robinhood Chain fork tests against
the exact v3 and v4 managers, include hooked and native-currency v4 pools,
commission an independent review of the final bytecode, complete the intended
multisig ownership transfer, and validate low-value positions. Pause the router
if any verification differs from expectations.
