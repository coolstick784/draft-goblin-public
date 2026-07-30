import test from 'node:test';
import assert from 'node:assert/strict';
import { rankEvaluatedRecommendations, recommendationDominates } from '../core/evaluate.js';

const tiedSimulation={interval:[.08,.12],championshipProbability:.097,rawProbability:.097,iterations:10000};
const candidate=(name,position,{mean,floor,ceiling,availability,need,planScore})=>({
  player:{name,position,mean,floor,ceiling},
  nextPickAvailability:availability,
  waitingForUserPick:false,
  factors:{need},
  planScore,
  simulation:{...tiedSimulation}
});

test('a higher-need FLEX candidate that sweeps mean, floor, and ceiling beats scarcity urgency',()=>{
  const urgentLowerNeed=candidate('Mark Andrews','TE',{mean:161.1,floor:139,ceiling:215,availability:.023,need:.24,planScore:.8});
  const betterRosterFit=candidate('Romeo Doubs','WR',{mean:167.3,floor:142,ceiling:226,availability:.084,need:.42,planScore:.7});
  assert.equal(recommendationDominates(betterRosterFit,urgentLowerNeed),true);
  assert.equal(rankEvaluatedRecommendations([urgentLowerNeed,betterRosterFit])[0].player.name,'Romeo Doubs');
});

test('a large FLEX projection sweep beats availability urgency at equal roster need',()=>{
  const urgentLowerProjection=candidate('Jacory Croskey-Merritt','RB',{mean:140.7,floor:121,ceiling:188,availability:.211,need:.42,planScore:.8});
  const dominantProjection=candidate('Romeo Doubs','WR',{mean:167.3,floor:142,ceiling:226,availability:.4,need:.42,planScore:.7});
  assert.equal(recommendationDominates(dominantProjection,urgentLowerProjection),true);
  assert.equal(rankEvaluatedRecommendations([urgentLowerProjection,dominantProjection])[0].player.name,'Romeo Doubs');
});

test('a large projection sweep cannot ignore a genuinely lower roster need',()=>{
  const requiredPosition=candidate('Required position','RB',{mean:140.7,floor:121,ceiling:188,availability:.211,need:1,planScore:.8});
  const lowerNeedProjection=candidate('Lower-need projection','WR',{mean:167.3,floor:142,ceiling:226,availability:.4,need:.42,planScore:.7});
  assert.equal(recommendationDominates(lowerNeedProjection,requiredPosition),false);
});

test('projection sweep does not override a genuinely greater positional need',()=>{
  const requiredPosition=candidate('Required position','TE',{mean:161.1,floor:139,ceiling:215,availability:.023,need:1,planScore:.8});
  const luxuryDepth=candidate('Luxury depth','WR',{mean:167.3,floor:142,ceiling:226,availability:.084,need:.42,planScore:.7});
  assert.equal(recommendationDominates(luxuryDepth,requiredPosition),false);
});

test('higher mean alone does not trigger the projection-sweep rule',()=>{
  const saferCandidate=candidate('Safer candidate','TE',{mean:161.1,floor:139,ceiling:230,availability:.023,need:.24,planScore:.8});
  const mixedProfile=candidate('Mixed profile','WR',{mean:167.3,floor:138,ceiling:226,availability:.084,need:.42,planScore:.7});
  assert.equal(recommendationDominates(mixedProfile,saferCandidate),false);
});
