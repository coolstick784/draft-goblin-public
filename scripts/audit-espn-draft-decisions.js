import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateDraft } from "../core/evaluate.js";
import { parseEspnDraftPaste } from "./analyze-espn-draft-paste.js";
import { buildEspnState } from "./recommend-live-espn.js";

const normalizedName=value=>String(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase();
export function auditEspnDraftDecisions(text,{targets=[],iterations=1000,seed=2026,limit=8,overrides={},teams=12}={}){
  const parsed=parseEspnDraftPaste(text,{teams}),pickNos=targets.length?targets:parsed.picks.filter(pick=>Number(pick.slot)===Number(parsed.userSlot)).map(pick=>Number(pick.pickNo));
  return pickNos.map(target=>{
    const state=buildEspnState({...parsed,projectionRows:parsed.picks,picks:parsed.picks.filter(pick=>Number(pick.pickNo)<Number(target)),draftId:`decision-audit-${target}`}),playersByName=new Map(state.players.map(player=>[normalizedName(player.name),player]));
    state.picks=state.picks.map(pick=>{const replacement=overrides[pick.pickNo];if(!replacement)return pick;const player=playersByName.get(normalizedName(replacement));if(!player)throw new Error(`Decision-audit override player not found: ${replacement}`);return{...pick,playerId:player.id,name:player.name}});
    const recommendations=evaluateDraft({state,userSlot:parsed.userSlot,strategy:"titleOnly",sourceProfile:"projectionLed",iterations:Math.max(1,iterations),seed,limit,includeSimulation:iterations>0});
    return{pickNo:Number(target),recommendations:recommendations.map((row,index)=>({
      rank:index+1,id:row.player.id,name:row.player.name,position:row.player.position,
      titleChance:row.simulation?.championshipProbability??null,rawTitleChance:row.simulation?.rawProbability??null,
      planScore:row.planScore,futureStarterAccess:row.futureStarterAccess,optionalityBonus:row.optionalityBonus,
      conditionalRolloutScore:row.conditionalRolloutScore,conditionalRolloutBonus:row.conditionalRolloutBonus,
      conditionalRolloutPicks:row.conditionalRolloutPicks,conditionalRolloutPath:row.conditionalRolloutPath,
      conditionalRolloutPathShare:row.conditionalRolloutPathShare,conditionalRolloutScenarios:row.conditionalRolloutScenarios,
      conditionalRolloutCoreCoverage:row.conditionalRolloutCoreCoverage,
      starterFlexibilityPenalty:row.starterFlexibilityPenalty,requiredStarterSlotsBefore:row.requiredStarterSlotsBefore
    }))};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const inputPath=process.argv[2],iterations=process.argv[3]===undefined?1000:Math.max(0,Number(process.argv[3])||0),targets=String(process.argv[4]||"").split(",").map(Number).filter(Number.isFinite),limit=Math.max(1,Number(process.argv[5])||8),overrides=process.argv[6]?JSON.parse(fs.readFileSync(process.argv[6],"utf8")):{},teams=Math.max(2,Number(process.argv[7])||12);
  if(!inputPath)throw new Error("Usage: node scripts/audit-espn-draft-decisions.js <paste.txt> [iterations] [pick,pick,...] [limit] [overrides.json] [teams]");
  console.log(JSON.stringify(auditEspnDraftDecisions(fs.readFileSync(inputPath,"utf8"),{targets,iterations,limit,overrides,teams}),null,2));
}
