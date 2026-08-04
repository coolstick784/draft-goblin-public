import test from "node:test"; import assert from "node:assert/strict";
import { snakeSlot, nextPickForSlot, validateDraftState } from "../shared/domain.js"; import { fixtureState } from "./fixture.js";
import { validateDraftState as validateBundledDraftState } from "../extension/engine/shared/domain.js";
test("snake order reverses each round",()=>assert.deepEqual(Array.from({length:8},(_,i)=>snakeSlot(i+1,4)),[1,2,3,4,4,3,2,1]));
test("finds next selection",()=>assert.equal(nextPickForSlot(4,2,4,3),7));
test("validates coherent state",()=>assert.equal(validateDraftState(fixtureState()).valid,true));
test("Yahoo is accepted by both server and bundled extension engines",()=>{const state={...fixtureState(),platform:"yahoo"};assert.equal(validateDraftState(state).valid,true);assert.equal(validateBundledDraftState(state).valid,true)});
test("rejects stale and duplicate state",()=>{const s=fixtureState();s.updatedAt=1;s.picks.push(s.picks[0]);const v=validateDraftState(s);assert.equal(v.valid,false);assert.match(v.errors.join(),/duplicate pick/);assert.match(v.errors.join(),/stale/)});
