export const OWNED_OVERLAY_METHOD = "position-aware-consensus-anchored-owned-overlay";
export const OWNED_OVERLAY_FORMATS = Object.freeze(["STD", "HALF", "PPR"]);
export const OWNED_OVERLAY_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DST"]);
export const OWNED_OVERLAY_POSITION_WEIGHTS = Object.freeze({
  QB: 0.5,
  RB: 0.5,
  WR: 0.5,
  TE: 0.5,
  K: 0.5,
  DST: 0,
});
export const MINIMUM_FROZEN_ROWS_PER_SLICE = 10;
export const OWNED_OVERLAY_CLOSENESS_LIMITS = Object.freeze({
  minimumSpearman: 0.95,
  maximumMedianStandardizedDistance: 0.20,
  maximumP90StandardizedDistance: 0.50,
});

export function hasExactOwnedOverlayWeights(value) {
  if (!value || Object.keys(value).length !== OWNED_OVERLAY_POSITIONS.length) return false;
  return OWNED_OVERLAY_POSITIONS.every(position =>
    Number(value[position]) === OWNED_OVERLAY_POSITION_WEIGHTS[position]
  );
}

export function assertPreregisteredOwnedOverlay(value) {
  if (!hasExactOwnedOverlayWeights(value)) {
    throw new Error("Position-owned weights do not match the preregistered overlay.");
  }
}

export function hasExactOwnedOverlayClosenessLimits(value) {
  if (!value || Object.keys(value).length !== Object.keys(OWNED_OVERLAY_CLOSENESS_LIMITS).length) return false;
  return Object.entries(OWNED_OVERLAY_CLOSENESS_LIMITS).every(([key, limit]) =>
    Number(value[key]) === limit
  );
}
