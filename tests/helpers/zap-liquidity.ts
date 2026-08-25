const Q96 = 1n << 96n;
const BPS = 10_000n;
const MAX_TICK = 887_272;
const MAX_UINT256 = (1n << 256n) - 1n;
const UINT32_MASK = (1n << 32n) - 1n;

// Exact integer port of the MIT-licensed Uniswap TickMath direction used by
// ScoplZapRouter. Keeping it test-local avoids importing the complete SDK and
// its unrelated Hardhat dependency tree.
function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > MAX_TICK) {
    throw new Error("Tick is outside the supported range");
  }
  const absTick = BigInt(Math.abs(tick));
  let price = (absTick & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const multipliers: ReadonlyArray<readonly [bigint, bigint]> = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n]
  ];
  for (const [mask, multiplier] of multipliers) {
    if ((absTick & mask) !== 0n) price = (price * multiplier) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  return (price >> 32n) + ((price & UINT32_MASK) === 0n ? 0n : 1n);
}

function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new Error("Square root is undefined for negative values");
  if (value < 2n) return value;
  let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

/**
 * Produces reciprocal-safe raw pool-price bounds. If the configured tolerance
 * is s, the allowed price interval is [P * (1-s), P / (1-s)].
 */
export function sqrtPriceBoundsFromSlippage(
  sqrtPriceX96: bigint,
  slippagePercent: number
): { minimumSqrtPriceX96: bigint; maximumSqrtPriceX96: bigint } {
  if (sqrtPriceX96 <= 0n) {
    throw new Error("A positive sqrt price is required");
  }
  const toleranceBps = BigInt(Math.max(
    0,
    Math.min(9_900, Math.ceil(slippagePercent * 100))
  ));
  const retainedBps = BPS - toleranceBps;
  const squaredPrice = sqrtPriceX96 * sqrtPriceX96;
  const minimumSqrtPriceX96 = integerSquareRoot(
    squaredPrice * retainedBps / BPS
  );
  const maximumNumerator = squaredPrice * BPS;
  const maximumFloor = integerSquareRoot(maximumNumerator / retainedBps);
  const maximumSqrtPriceX96 =
    maximumFloor * maximumFloor * retainedBps < maximumNumerator
      ? maximumFloor + 1n
      : maximumFloor;
  return { minimumSqrtPriceX96, maximumSqrtPriceX96 };
}

export function sqrtPriceBoundsForTicks(
  tickLower: number,
  tickUpper: number
): { sqrtPriceLowerX96: bigint; sqrtPriceUpperX96: bigint } {
  return {
    sqrtPriceLowerX96: sqrtPriceAtTick(tickLower),
    sqrtPriceUpperX96: sqrtPriceAtTick(tickUpper)
  };
}

function liquidityForAmount0(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint
): bigint {
  if (amount0 === 0n || sqrtRatioAX96 >= sqrtRatioBX96) return 0n;
  return amount0 * sqrtRatioAX96 * sqrtRatioBX96 /
    (sqrtRatioBX96 - sqrtRatioAX96) / Q96;
}

function liquidityForAmount1(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount1: bigint
): bigint {
  if (amount1 === 0n || sqrtRatioAX96 >= sqrtRatioBX96) return 0n;
  return amount1 * Q96 / (sqrtRatioBX96 - sqrtRatioAX96);
}

/**
 * Computes a V3/V4-compatible liquidity ceiling directly from the raw token
 * amounts. This avoids scaling the range simulator's floating-point USD model,
 * which can request more of one token than a two-stage Zap actually prepared.
 */
export function maximumLiquidityForZap(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
}): bigint {
  const {
    sqrtPriceLowerX96: sqrtLowerX96,
    sqrtPriceUpperX96: sqrtUpperX96
  } = sqrtPriceBoundsForTicks(input.tickLower, input.tickUpper);

  if (input.sqrtPriceX96 <= sqrtLowerX96) {
    return liquidityForAmount0(
      sqrtLowerX96,
      sqrtUpperX96,
      input.amount0
    );
  }
  if (input.sqrtPriceX96 >= sqrtUpperX96) {
    return liquidityForAmount1(
      sqrtLowerX96,
      sqrtUpperX96,
      input.amount1
    );
  }

  const liquidity0 = liquidityForAmount0(
    input.sqrtPriceX96,
    sqrtUpperX96,
    input.amount0
  );
  const liquidity1 = liquidityForAmount1(
    sqrtLowerX96,
    input.sqrtPriceX96,
    input.amount1
  );
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}

export function safeV4ZapLiquidity(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  slippagePercent: number;
}): bigint {
  const maximum = maximumLiquidityForZap(input);
  return minimumLiquidityFromMaximum(maximum, input.slippagePercent);
}

export function minimumLiquidityFromMaximum(
  maximum: bigint,
  slippagePercent: number
): bigint {
  if (maximum === 0n) return 0n;
  const toleranceBps = BigInt(Math.max(
    0,
    Math.min(9_900, Math.ceil(slippagePercent * 100))
  ));
  const minimum = maximum * (BPS - toleranceBps) / BPS;
  return minimum > 0n ? minimum : 1n;
}
