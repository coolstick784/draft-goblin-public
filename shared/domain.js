export const DEFAULT_SETTINGS = Object.freeze({ teams: 12, rounds: 15, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 }, positionLimits: {}, scoring: { reception: 1, passTd: 4, rushTd: 6, receiveTd: 6 }, playoffTeams: 6, playoffWeeks: 3 });
export const STRATEGIES = Object.freeze({
  balanced: { projection: .52, ceiling: .10, floor: .08, scarcity: .09, need: .15, availability: .04, history:0, risk: -.03 },
  // Title simulations remain the final judge. When 10k paired simulations
  // cannot separate candidates, resolve the tie toward asymmetric ceiling
  // instead of silently falling back to the balanced policy.
  titleOnly: { projection: .32, ceiling: .32, floor: 0, scarcity: .08, need: .14, availability: .02, history:0, risk: .12 },
  upside: { projection: .38, ceiling: .28, floor: .02, scarcity: .08, need: .12, availability: .06, history:0, risk: .05 },
  safe: { projection: .28, ceiling: .06, floor: .29, scarcity: .15, need: .15, availability: .06, history:0, risk: -.08 },
  projection: { projection: .59, ceiling: .10, floor: .10, scarcity: .08, need: .08, availability: .04, history:0, risk: -.02 }
});
export const SOURCE_PROFILES=Object.freeze({
  projectionLed:{projection:.55,ceiling:.10,floor:.08,scarcity:.08,need:.14,availability:.04,history:0,risk:-.03},
  ownedModel:{projection:.62,ceiling:.09,floor:.08,scarcity:.07,need:.11,availability:.02,history:0,risk:-.02},
  marketLed:{projection:.43,ceiling:.07,floor:.06,scarcity:.07,need:.10,availability:.24,history:0,risk:-.02}
});
export function normalizeSettings(value = {}) { return { ...DEFAULT_SETTINGS, ...value, slots: { ...DEFAULT_SETTINGS.slots, ...(value.slots || {}) }, positionLimits: { ...DEFAULT_SETTINGS.positionLimits, ...(value.positionLimits || {}) }, scoring: { ...DEFAULT_SETTINGS.scoring, ...(value.scoring || {}) } }; }
export function validateDraftState(state) {
  const errors = [];
  if (!state || typeof state !== "object") return { valid: false, errors: ["draft state is missing"] };
  if (!["sleeper", "espn", "fixture"].includes(state.platform)) errors.push("unsupported platform");
  if (!state.draftId) errors.push("draftId is required");
  if (!Array.isArray(state.picks)) errors.push("picks must be an array");
  if (!Array.isArray(state.players)) errors.push("players must be an array");
  const pickNos = new Set();
  for (const pick of state.picks || []) { if (!Number.isInteger(pick.pickNo) || pick.pickNo < 1) errors.push("invalid pick number"); if (pickNos.has(pick.pickNo)) errors.push(`duplicate pick ${pick.pickNo}`); pickNos.add(pick.pickNo); if (!pick.playerId) errors.push(`pick ${pick.pickNo} has no player`); }
  const ids = new Set((state.players || []).map(p => p.id));
  if (ids.size !== (state.players || []).length) errors.push("duplicate player id");
  if ((state.picks || []).some(p => !ids.has(p.playerId))) errors.push("picked player missing from catalog");
  if (Date.now() - Number(state.updatedAt || 0) > 120000) errors.push("draft state is stale");
  return { valid: !errors.length, errors };
}
export function snakeSlot(pickNo, teams) { const round = Math.floor((pickNo - 1) / teams) + 1, within = ((pickNo - 1) % teams) + 1; return round % 2 ? within : teams + 1 - within; }
export function nextPickForSlot(afterPick, slot, teams, rounds) { for (let n = afterPick + 1; n <= teams * rounds; n++) if (snakeSlot(n, teams) === slot) return n; return null; }
