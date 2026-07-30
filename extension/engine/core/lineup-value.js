import { lineupScore } from "./roster.js";

const SPECIALISTS=new Set(["K","DST"]);
const CORE=new Set(["QB","RB","WR","TE"]);
const value=(player,key="mean")=>Number(player?.[key]??player?.mean??0);
export const SPECIALIST_REGRESSION_WEIGHT=.20;
export const SPECIALIST_EDGE_CAP=12;

// Kicker and defense projections are unstable and a usable replacement is
// normally available for free. Retain only a small, capped, risk-adjusted edge.
export function regressedSpecialistValue(player,replacement,key="mean"){
  const raw=value(player,key),baseline=value(replacement,key);
  if(!SPECIALISTS.has(player?.position)||!replacement)return raw;
  const reliability=Math.max(.5,Math.min(1,1-Number(player.risk||0)*.75));
  const edge=Math.max(0,raw-baseline);
  return baseline+Math.min(SPECIALIST_EDGE_CAP,edge*SPECIALIST_REGRESSION_WEIGHT*reliability);
}

export function specialistWaiverBaseline(position,pool,settings,key="mean"){
  if(!SPECIALISTS.has(position))return null;
  const same=pool.filter(player=>player.position===position).sort((a,b)=>value(b,key)-value(a,key));
  if(!same.length)return null;
  const expectedStarters=Math.max(1,Number(settings.teams||10)*Math.max(1,Number(settings.slots?.[position]||1)));
  return same[Math.min(same.length-1,expectedStarters)];
}

export function specialistAdjustedValue(player,pool,settings,key="mean"){
  if(!SPECIALISTS.has(player?.position))return value(player,key);
  return regressedSpecialistValue(player,specialistWaiverBaseline(player.position,pool,settings,key),key);
}

export function candidateLineupMetrics(player,roster,settings,pool=[]){
  const baseline=lineupScore(roster,settings.slots,p=>value(p));
  const replacement=isSpecialist(player?.position)?specialistReplacement(player,pool,settings):null;
  const projected=lineupScore([...roster,player],settings.slots,p=>p===player?regressedSpecialistValue(p,replacement):value(p));
  const starterContribution=Math.max(0,projected-baseline);
  return{expectedWeeklyPoints:projected/17,expectedWeeklyDelta:starterContribution/17,starterContribution};
}

export function specialistReplacement(player,pool,settings){
  if(!SPECIALISTS.has(player?.position))return null;
  const same=pool.filter(candidate=>candidate.position===player.position&&candidate.id!==player.id).sort((a,b)=>value(b)-value(a));
  if(!same.length)return null;
  const replacementIndex=Math.min(same.length-1,Math.max(0,Number(settings.teams||10)-2));
  return same[replacementIndex];
}

export function specialistOpportunity({player,pool,roster,settings,completionRequired=false,eligibilityOnly=false}){
  if(!SPECIALISTS.has(player?.position))return{eligible:false,replacement:null,replacementDelta:0,uncertaintyAdjustedDelta:0,coreOpportunityCost:0};
  const count=roster.filter(item=>item.position===player.position).length,required=Number(settings.slots[player.position]||0);
  if(count>=required)return{eligible:false,replacement:null,replacementDelta:0,uncertaintyAdjustedDelta:0,coreOpportunityCost:Infinity};
  const replacement=specialistReplacement(player,pool,settings);
  if(!replacement&&!completionRequired)return{eligible:false,replacement:null,replacementDelta:0,uncertaintyAdjustedDelta:0,coreOpportunityCost:Infinity,hurdle:Infinity};
  const replacementDelta=Math.max(0,value(player)-value(replacement));
  const adjustedMeanDelta=Math.max(0,regressedSpecialistValue(player,replacement)-value(replacement));
  const adjustedFloorDelta=Math.max(0,regressedSpecialistValue(player,replacement,"floor")-value(replacement,"floor"));
  const uncertaintyAdjustedDelta=.6*adjustedMeanDelta+.4*adjustedFloorDelta;
  // The full core-opportunity calculation repeatedly builds and sorts lineups.
  // Draft simulation only consumes `eligible`, and the final hurdle can never
  // be lower than six points. Avoid that expensive calculation when the
  // specialist cannot clear the hard floor regardless of the core pool.
  if(eligibilityOnly&&!completionRequired&&uncertaintyAdjustedDelta<6)return{eligible:false,replacement,replacementDelta,adjustedMeanDelta,adjustedFloorDelta,uncertaintyAdjustedDelta,coreOpportunityCost:0,hurdle:6};
  const coreOpportunityCost=pool.filter(candidate=>CORE.has(candidate.position)).reduce((best,candidate)=>Math.max(best,candidateLineupMetrics(candidate,roster,settings).starterContribution),0);
  const hurdle=Math.max(6,coreOpportunityCost*.40);
  return{eligible:completionRequired||uncertaintyAdjustedDelta>=hurdle,replacement,replacementDelta,adjustedMeanDelta,adjustedFloorDelta,uncertaintyAdjustedDelta,coreOpportunityCost,hurdle};
}

export function isSpecialist(position){return position==="K"||position==="DST"}
