import { availabilityAfterSelection } from "./availability.js";
import { lineupPlayers, rosterNeeds } from "./roster.js";
import { nextPickForSlot } from "../shared/domain.js";

const CORE_POSITIONS=["QB","RB","WR","TE"];
const FLEX_POSITIONS=new Set(["RB","WR","TE"]);
const value=(player,key="mean")=>Number(player?.[key]??player?.mean??0);
const countPositions=roster=>roster.reduce((out,player)=>((out[player.position]=Number(out[player.position]||0)+1),out),{});

function replacementDemand(position,settings){
  const teams=Number(settings.teams||10),slots=settings.slots||{},flex=Number(slots.FLEX||0),superflex=Number(slots.SUPER_FLEX||slots.OP||0),flexShare=position==="RB"?.45:position==="WR"?.45:position==="TE"?.10:0,superflexShare=position==="QB"?.75:(FLEX_POSITIONS.has(position)?.25/3:0);
  return Math.max(1,Math.round(teams*(Number(slots[position]||0)+flex*flexShare+superflex*superflexShare)));
}

function positionCap(position,settings){
  const slots=settings.slots||{},required=Number(slots[position]||0),bench=Number(slots.BENCH||0),flex=Number(slots.FLEX||0),fallback=position==="QB"?required+1:position==="TE"?required+1:FLEX_POSITIONS.has(position)?required+flex+Math.max(1,Math.ceil(bench*.35)):required,explicit=Number(settings.positionLimits?.[position]);
  return Number.isFinite(explicit)&&explicit>=0?Math.min(fallback,explicit):fallback;
}

function playerIdentityIndex(players){
  const index=new Map();
  for(const player of players||[]){index.set(String(player.id),player);if(player.platformPlayerId!==undefined&&player.platformPlayerId!==null&&!index.has(String(player.platformPlayerId)))index.set(String(player.platformPlayerId),player)}
  return index;
}

function replacementLevels(state,draftable){
  const byId=playerIdentityIndex(state.players),drafted=countPositions((state.picks||[]).map(pick=>byId.get(String(pick.playerId))).filter(Boolean)),levels=new Map();
  for(const position of CORE_POSITIONS){
    const pool=draftable.filter(player=>player.position===position),remaining=Math.max(0,replacementDemand(position,state.settings)-Number(drafted[position]||0)),level={};
    for(const key of ["mean","floor","ceiling"]){const sorted=[...pool].sort((a,b)=>value(b,key)-value(a,key)),index=Math.min(Math.max(0,remaining),Math.max(0,sorted.length-1));level[key]=value(sorted[index],key)}
    levels.set(position,level);
  }
  return levels;
}

function titleValue(player,levels){
  const replacement=levels.get(player.position)||{mean:0,floor:0,ceiling:0},mean=Math.max(0,value(player,"mean")-replacement.mean),floor=Math.max(0,value(player,"floor")-replacement.floor),ceiling=Math.max(0,value(player,"ceiling")-replacement.ceiling);
  return mean*.25+ceiling*.65+floor*.10;
}
const rawTitleValue=player=>value(player,"mean")*.25+value(player,"ceiling")*.65+value(player,"floor")*.10;

function stableUnit(value){
  const text=String(value),cached=stableUnit.cache.get(text);if(cached!==undefined)return cached;
  let hash=2166136261;for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,16777619)}const result=(hash>>>0)/4294967296;stableUnit.cache.set(text,result);return result;
}
stableUnit.cache=new Map();

function scenarioUnit(playerId,scenario,scenarios){return((scenario+.5)/scenarios+stableUnit(playerId))%1}

function rosterUtility(roster,settings,rawValues,marginalValues,levels){
  const selection=player=>Number(rawValues.get(String(player.id))||0),marginal=player=>Number(marginalValues.get(String(player.id))||0),replacementValue=position=>{const level=levels.get(position)||{mean:0,floor:0,ceiling:0};return Number(level.mean||0)*.25+Number(level.ceiling||0)*.65+Number(level.floor||0)*.10},starters=lineupPlayers(roster,settings.slots,selection),starterScore=starters.reduce((sum,player)=>sum+selection(player),0),starterIds=new Set(starters.map(player=>String(player.id))),depth=roster.filter(player=>FLEX_POSITIONS.has(player.position)&&!starterIds.has(String(player.id))).map(marginal).sort((a,b)=>b-a).slice(0,2).reduce((sum,row)=>sum+row,0),needs=rosterNeeds(roster,settings.slots),coreReplacement=CORE_POSITIONS.reduce((sum,position)=>sum+Number(needs[position]||0)*replacementValue(position),0),flexReplacement=Math.max(...[...FLEX_POSITIONS].map(replacementValue)),flexCompletion=Number(needs.FLEX||0)*flexReplacement;
  // Score FLEX candidates on the same raw title scale. Position-specific VOR
  // is correct inside a core slot, but using it across FLEX positions
  // double-counts TE scarcity and can prefer TE2 while RB2/WR2 are empty.
  // Complete unresolved slots with their replacement value so the bounded
  // horizon estimates the eventual lineup rather than punishing it twice.
  return starterScore+coreReplacement+flexCompletion+depth*.08;
}

function legalFuturePick(player,roster,settings){
  const counts=countPositions(roster);
  return CORE_POSITIONS.includes(player.position)&&Number(counts[player.position]||0)<positionCap(player.position,settings);
}

function futurePickNumbers(selectionPick,userSlot,settings,depth){
  const picks=[];let after=Number(selectionPick);
  for(let index=0;index<depth;index++){const pick=nextPickForSlot(after,userSlot,Number(settings.teams),Number(settings.rounds));if(!pick)break;picks.push(pick);after=pick}
  return picks;
}

function rolloutPool(draftable,values){
  const pool=[];
  for(const position of CORE_POSITIONS)pool.push(...draftable.filter(player=>player.position===position).sort((a,b)=>Number(values.get(String(b.id))||0)-Number(values.get(String(a.id))||0)||(position==="TE"?Number(b.mean||0)-Number(a.mean||0):Number(a.adp||9999)-Number(b.adp||9999))).slice(0,10));
  return[...new Map(pool.map(player=>[String(player.id),player])).values()];
}

function scenarioBoards(pool,futurePicks,selectionPick,state,scenarios){
  const probabilities=new Map(pool.map(player=>[String(player.id),futurePicks.map(target=>availabilityAfterSelection(player,target,selectionPick,{season:state.projectionSeason,settings:state.settings}))]));
  return futurePicks.map((_,pickIndex)=>Array.from({length:scenarios},(_,scenario)=>pool.filter(player=>scenarioUnit(player.id,scenario,scenarios)<Number(probabilities.get(String(player.id))?.[pickIndex]||0))));
}

function bestScenarioPath({candidate,roster,boards,scenario,rawValues,marginalValues,levels,state,beamWidth,choiceWidth}){
  let beam=[{roster:[...roster,candidate],chosen:new Set([String(candidate.id)]),path:[],score:0}];beam[0].score=rosterUtility(beam[0].roster,state.settings,rawValues,marginalValues,levels);
  for(const pickBoards of boards){
    const board=pickBoards[scenario]||[],next=[];
    for(const branch of beam){
      const choices=board.filter(player=>!branch.chosen.has(String(player.id))&&legalFuturePick(player,branch.roster,state.settings)).map(player=>({player,score:rosterUtility([...branch.roster,player],state.settings,rawValues,marginalValues,levels)})).sort((a,b)=>b.score-a.score||String(a.player.id).localeCompare(String(b.player.id))).slice(0,choiceWidth);
      if(!choices.length){next.push({...branch,path:[...branch.path,null]});continue}
      for(const choice of choices){const chosen=new Set(branch.chosen);chosen.add(String(choice.player.id));next.push({roster:[...branch.roster,choice.player],chosen,path:[...branch.path,choice.player],score:choice.score})}
    }
    const unique=new Map(),ordered=next.sort((a,b)=>b.score-a.score||String(a.path.at(-1)?.id||"").localeCompare(String(b.path.at(-1)?.id||"")));
    for(const branch of ordered){const key=branch.roster.map(player=>String(player.id)).sort().join("|");if(!unique.has(key))unique.set(key,branch);if(unique.size>=beamWidth)break}
    beam=[...unique.values()];
  }
  return beam.sort((a,b)=>b.score-a.score)[0];
}

function representativePath(paths,futurePicks,scenarios,rawValues){
  const minimumCount=Math.max(2,Math.ceil(scenarios*.25)),selected=[],chosen=new Set();
  for(let pickIndex=0;pickIndex<futurePicks.length;pickIndex++){
    const counts=new Map();
    for(const path of paths){
      const player=path[pickIndex],id=String(player?.id||"");
      if(!id||chosen.has(id))continue;
      const row=counts.get(id)||{player,count:0};row.count++;counts.set(id,row)
    }
    const best=[...counts.values()].sort((a,b)=>b.count-a.count||Number(rawValues.get(String(b.player.id))||0)-Number(rawValues.get(String(a.player.id))||0)||String(a.player.id).localeCompare(String(b.player.id)))[0];
    if(!best||best.count<minimumCount)continue;
    chosen.add(String(best.player.id));selected.push({player:best.player,pickIndex,pickNo:futurePicks[pickIndex]})
  }
  return selected;
}

export function conditionalMultiPickRollouts({candidates,roster,draftable,state,userSlot,selectionPick,depth=2,scenarios=24,beamWidth=5,choiceWidth=5}){
  const futurePicks=futurePickNumbers(selectionPick,userSlot,state.settings,depth),result=new Map();
  if(!futurePicks.length||!candidates?.length)return{active:false,futurePicks,scenarios:0,results:result};
  const levels=replacementLevels(state,draftable),marginalValues=new Map((state.players||[]).map(player=>[String(player.id),titleValue(player,levels)])),rawValues=new Map((state.players||[]).map(player=>[String(player.id),rawTitleValue(player)])),pool=rolloutPool(draftable,marginalValues),boards=scenarioBoards(pool,futurePicks,selectionPick,state,scenarios);
  for(const candidate of candidates){
    let total=0;const paths=[];
    for(let scenario=0;scenario<scenarios;scenario++){const best=bestScenarioPath({candidate,roster,boards,scenario,rawValues,marginalValues,levels,state,beamWidth,choiceWidth});total+=best.score;paths.push(best.path)}
    const representative=representativePath(paths,futurePicks,scenarios,rawValues),needs=rosterNeeds([...roster,candidate],state.settings.slots),requirements=Object.fromEntries(CORE_POSITIONS.map(position=>[position,Number(needs[position]||0)])),covered=path=>{const counts=countPositions(path.filter(Boolean));return Object.entries(requirements).every(([position,required])=>Number(counts[position]||0)>=required)},coreCoverageProbability=paths.filter(covered).length/scenarios,pathShare=representative.length?paths.filter(path=>representative.every(item=>String(path[item.pickIndex]?.id||"")===String(item.player.id))).length/scenarios:0;
    result.set(String(candidate.id),{score:total/scenarios,path:representative.map(({player,pickNo})=>({id:player.id,name:player.name,position:player.position,pickNo})),pathShare,coreCoverageProbability});
  }
  return{active:true,futurePicks,scenarios,results:result};
}
