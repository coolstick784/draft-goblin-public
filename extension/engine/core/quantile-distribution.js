export const QUANTILE_DISTRIBUTION_VERSION = 1;
export const PLAYER_QUANTILE_SCHEMA_VERSION = "quantile-v1";

const DEFAULT_TAIL_GROWTH = 3;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function readGrid(input) {
  if (!input || typeof input !== "object") throw new TypeError("quantile distribution must be an object");
  // Normalization freezes an already validated compact grid. Sampling visits
  // this path millions of times in a full evaluation, so reuse those arrays
  // instead of allocating and re-validating them for every player draw.
  if (input.version === QUANTILE_DISTRIBUTION_VERSION && Object.isFrozen(input) && Object.isFrozen(input.probabilities) && Object.isFrozen(input.values)) {
    return { probabilities: input.probabilities, values: input.values };
  }
  const compactVersion = input.version === QUANTILE_DISTRIBUTION_VERSION;
  const playerSchemaVersion = input.schemaVersion === PLAYER_QUANTILE_SCHEMA_VERSION;
  if (!compactVersion && !playerSchemaVersion) {
    throw new RangeError(`unsupported quantile distribution version: ${String(input.schemaVersion ?? input.version)}`);
  }

  let probabilities;
  let values;
  if (Array.isArray(input.quantiles)) {
    probabilities = input.quantiles.map((point, index) => finiteNumber(point?.p, `quantiles[${index}].p`));
    values = input.quantiles.map((point, index) => finiteNumber(point?.value, `quantiles[${index}].value`));
  } else {
    if (!Array.isArray(input.probabilities) || !Array.isArray(input.values)) {
      throw new TypeError("distribution requires probabilities and values arrays");
    }
    probabilities = input.probabilities.map((value, index) => finiteNumber(value, `probabilities[${index}]`));
    values = input.values.map((value, index) => finiteNumber(value, `values[${index}]`));
  }

  if (probabilities.length !== values.length) throw new RangeError("probabilities and values must have equal length");
  if (probabilities.length < 2) throw new RangeError("at least two quantiles are required");
  probabilities.forEach((probability, index) => {
    if (probability < 0 || probability > 1) throw new RangeError("quantile probabilities must be between 0 and 1");
    if (index && probability <= probabilities[index - 1]) {
      throw new RangeError("quantile probabilities must be strictly increasing");
    }
  });
  return { probabilities, values };
}

// Pool-adjacent-violators is the least-squares monotone repair. Unlike a running
// maximum, it does not systematically push every later quantile upward.
function isotonic(values) {
  const blocks = [];
  values.forEach((value, index) => {
    blocks.push({ start: index, end: index, sum: value, weight: 1 });
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.sum / left.weight <= right.sum / right.weight) break;
      blocks.splice(-2, 2, {
        start: left.start,
        end: right.end,
        sum: left.sum + right.sum,
        weight: left.weight + right.weight
      });
    }
  });
  const repaired = new Array(values.length);
  blocks.forEach((block) => {
    const value = block.sum / block.weight;
    for (let index = block.start; index <= block.end; index += 1) repaired[index] = value;
  });
  return repaired;
}

function tailExtension(probabilityWidth, adjacentProbabilityWidth, adjacentRise, fullRange, growth) {
  if (!(probabilityWidth > 0) || !(adjacentProbabilityWidth > 0)) return 0;
  const linear = adjacentRise * probabilityWidth / adjacentProbabilityWidth;
  const cap = Math.max(adjacentRise * growth, fullRange * 0.5, Number.EPSILON);
  return Math.min(Math.max(0, linear), cap);
}

function addTails(probabilities, values, { lowerBound, upperBound, tailGrowth }) {
  const ps = [...probabilities];
  const qs = [...values];
  const range = qs.at(-1) - qs[0];
  if (ps[0] > 0) {
    const rise = qs[1] - qs[0];
    const extension = tailExtension(ps[0], ps[1] - ps[0], rise, range, tailGrowth);
    ps.unshift(0);
    qs.unshift(Math.max(lowerBound, qs[0] - extension));
  }
  if (ps.at(-1) < 1) {
    const last = ps.length - 1;
    const rise = qs[last] - qs[last - 1];
    const extension = tailExtension(1 - ps[last], ps[last] - ps[last - 1], rise, range, tailGrowth);
    ps.push(1);
    qs.push(Math.min(upperBound, qs[last] + extension));
  }
  return { probabilities: ps, values: qs };
}

export function meanOfQuantileDistribution(distribution) {
  const { probabilities, values } = readGrid(distribution);
  let area = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    area += (probabilities[index] - probabilities[index - 1]) * (values[index] + values[index - 1]) / 2;
  }
  // Non-normalized grids have constant mass outside their first/last anchors.
  area += probabilities[0] * values[0] + (1 - probabilities.at(-1)) * values.at(-1);
  return area;
}

function recenter(values, currentMean, targetMean, lowerBound, upperBound) {
  if (Math.abs(currentMean - targetMean) <= 1e-12) return values;
  if (targetMean < lowerBound || targetMean > upperBound) {
    throw new RangeError("target mean must be inside the distribution bounds");
  }

  if (Number.isFinite(lowerBound) && targetMean <= currentMean) {
    if (currentMean === lowerBound) return values.map(() => targetMean);
    const scale = (targetMean - lowerBound) / (currentMean - lowerBound);
    return values.map((value) => lowerBound + (value - lowerBound) * scale);
  }
  if (Number.isFinite(upperBound) && targetMean >= currentMean) {
    if (currentMean === upperBound) return values.map(() => targetMean);
    const scale = (upperBound - targetMean) / (upperBound - currentMean);
    return values.map((value) => upperBound - (upperBound - value) * scale);
  }
  const shift = targetMean - currentMean;
  return values.map((value) => value + shift);
}

export function normalizeQuantileDistribution(input, options = {}) {
  const grid = readGrid(input);
  const lowerBound = options.lowerBound == null ? -Infinity : finiteNumber(options.lowerBound, "lowerBound");
  const upperBound = options.upperBound == null ? Infinity : finiteNumber(options.upperBound, "upperBound");
  if (lowerBound >= upperBound) throw new RangeError("lowerBound must be less than upperBound");
  const tailGrowth = options.tailGrowth == null ? DEFAULT_TAIL_GROWTH : finiteNumber(options.tailGrowth, "tailGrowth");
  if (tailGrowth < 0) throw new RangeError("tailGrowth must be non-negative");

  const bounded = grid.values.map((value) => Math.min(upperBound, Math.max(lowerBound, value)));
  let normalized = addTails(grid.probabilities, isotonic(bounded), { lowerBound, upperBound, tailGrowth });
  const declaredMean = options.targetMean ?? input.mean;
  if (declaredMean != null) {
    const targetMean = finiteNumber(declaredMean, "targetMean");
    const currentMean = meanOfQuantileDistribution({ version: 1, ...normalized });
    normalized.values = recenter(normalized.values, currentMean, targetMean, lowerBound, upperBound);
  }

  // Floating-point recentering can leave microscopic crossings at a bound.
  normalized.values = isotonic(normalized.values).map((value) => Math.min(upperBound, Math.max(lowerBound, value)));
  const result = {
    version: QUANTILE_DISTRIBUTION_VERSION,
    probabilities: Object.freeze(normalized.probabilities),
    values: Object.freeze(normalized.values)
  };
  result.mean = meanOfQuantileDistribution(result);
  return Object.freeze(result);
}

export function quantileAt(distribution, uniform) {
  const { probabilities, values } = readGrid(distribution);
  const probability = finiteNumber(uniform, "uniform");
  if (probability < 0 || probability > 1) throw new RangeError("uniform must be between 0 and 1");
  if (probability <= probabilities[0]) return values[0];
  if (probability >= probabilities.at(-1)) return values.at(-1);
  let low = 0;
  let high = probabilities.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (probabilities[middle] <= probability) low = middle;
    else high = middle;
  }
  const fraction = (probability - probabilities[low]) / (probabilities[high] - probabilities[low]);
  return values[low] + fraction * (values[high] - values[low]);
}

// Abramowitz-Stegun normal CDF approximation; deterministic and accurate enough
// for transforming an already-supplied simulation shock into a percentile.
function standardNormalCdf(value) {
  const z = finiteNumber(value, "normal");
  if (z === 0) return 0.5;
  if (z <= -8) return 0;
  if (z >= 8) return 1;
  const absolute = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = Math.exp(-absolute * absolute / 2) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

export function sampleQuantileDistribution(distribution, draw) {
  if (typeof draw === "number") return quantileAt(distribution, draw);
  if (!draw || typeof draw !== "object") throw new TypeError("draw must supply uniform or normal");
  const hasUniform = draw.uniform != null;
  const hasNormal = draw.normal != null;
  if (hasUniform === hasNormal) throw new TypeError("draw must supply exactly one of uniform or normal");
  return quantileAt(distribution, hasUniform ? draw.uniform : standardNormalCdf(draw.normal));
}

export function distributionFromSummary(summary, options = {}) {
  if (!summary || typeof summary !== "object") throw new TypeError("summary must be an object");
  const mean = finiteNumber(summary.mean, "mean");
  const floor = finiteNumber(summary.floor, "floor");
  const ceiling = finiteNumber(summary.ceiling, "ceiling");
  if (floor > mean || mean > ceiling) throw new RangeError("summary must satisfy floor <= mean <= ceiling");
  const floorProbability = options.floorProbability == null ? 0.1 : finiteNumber(options.floorProbability, "floorProbability");
  const ceilingProbability = options.ceilingProbability == null ? 0.9 : finiteNumber(options.ceilingProbability, "ceilingProbability");
  if (!(floorProbability > 0 && floorProbability < 0.5 && ceilingProbability > 0.5 && ceilingProbability < 1)) {
    throw new RangeError("summary probabilities must bracket 0.5 inside (0, 1)");
  }
  return normalizeQuantileDistribution({
    version: QUANTILE_DISTRIBUTION_VERSION,
    probabilities: [floorProbability, 0.5, ceilingProbability],
    values: [floor, mean, ceiling],
    mean
  }, { lowerBound: options.lowerBound ?? 0, upperBound: options.upperBound, tailGrowth: options.tailGrowth });
}
