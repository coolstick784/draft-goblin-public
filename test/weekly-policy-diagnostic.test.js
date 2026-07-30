import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicyAtState } from "../scripts/diagnose-weekly-policy-ab.js";
import { pairedDifference, WEEKLY_SIMULATION_MODEL } from "../core/simulate.js";
import { fixtureState } from "./fixture.js";

test("research policy evaluator keeps paired evidence within one simulator world", () => { const state = fixtureState({ teams: 4, rounds: 6, picked: 3 }), options = { state, userSlot: 4, iterations: 12, seed: 99, limit: 3 }, legacy = evaluatePolicyAtState(options), weekly = evaluatePolicyAtState({ ...options, simulationModel: WEEKLY_SIMULATION_MODEL }); assert.ok(legacy.length && weekly.length); assert.ok(legacy.every(item => item.simulation.scenarioBankId === legacy[0].simulation.scenarioBankId)); assert.ok(weekly.every(item => item.simulation.scenarioBankId === weekly[0].simulation.scenarioBankId)); assert.notEqual(legacy[0].simulation.scenarioBankId, weekly[0].simulation.scenarioBankId); assert.equal(pairedDifference(legacy[0].simulation, weekly[0].simulation), null); });
