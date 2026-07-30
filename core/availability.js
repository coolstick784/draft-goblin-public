const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,n));
import { AVAILABILITY_CALIBRATION_2026 } from "./availability-calibration-2026.js";

const scoringKey=settings=>{const reception=Number(settings?.scoring?.reception||0);return reception>=.75?"ppr":reception>=.25?"half-ppr":"standard"};
const interpolate=(curve,x)=>{if(x<=curve[0][0])return curve[0][1];for(let i=1;i<curve.length;i++)if(x<=curve[i][0]){const[a,av]=curve[i-1],[b,bv]=curve[i],w=(x-a)/(b-a);return av+(bv-av)*w}return curve.at(-1)[1]};
export function availabilityCalibration(context={}){
  if(Number(context.season)!==AVAILABILITY_CALIBRATION_2026.season)return null;
  const teams=Number(context.settings?.teams||context.teams),scoring=scoringKey(context.settings||context),exact=AVAILABILITY_CALIBRATION_2026.cells[`${teams}:${scoring}`];
  if(exact)return exact;
  const sameScoring=Object.values(AVAILABILITY_CALIBRATION_2026.cells).filter(cell=>cell.scoring===scoring).sort((a,b)=>Math.abs(a.teams-teams)-Math.abs(b.teams-teams));
  return sameScoring[0]||null;
}
export function marketPickSd(player,context={}){
  if(String(player?.position||"").toUpperCase()==="TE")return null;
  const adp=Number(player?.adp);
  if(!Number.isFinite(adp)||adp<=0||adp>=500)return null;
  const calibration=availabilityCalibration(context);
  if(!calibration)return null;
  const rankPrior=interpolate(calibration.curve,adp),observed=Number(player?.adpSd),source=String(player?.adpSdSource||""),season=Number(player?.adpSeason),teams=Number(player?.adpTeams),scoring=String(player?.adpScoring||"");
  const matched=season===2026&&teams===calibration.teams&&scoring===calibration.scoring;
  return matched&&Number.isFinite(observed)&&observed>0&&["observed","provider-observed","mock-drafts"].includes(source)?clamp(observed,.5,Math.max(2,rankPrior*2.5)):rankPrior;
}

export function marketPickCenter(player,context={}){
  // Overall ADP is not a trustworthy TE timing signal. TE decisions are made
  // from projections, positional tiers, scarcity, and roster need instead.
  if(String(player?.position||"").toUpperCase()==="TE")return null;
  const adp=Number(player?.adp);
  if(!Number.isFinite(adp)||adp<=0||adp>=500)return null;
  return adp;
}

function normalCdf(z){
  const sign=z<0?-1:1,x=Math.abs(z)/Math.sqrt(2),t=1/(1+.3275911*x);
  const erf=1-(((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t)*Math.exp(-x*x);
  return .5*(1+sign*erf);
}
export function marketSurvival(player,pick,context={}){
  const center=marketPickCenter(player,context),target=Number(pick),sd=marketPickSd(player,context);
  if(center==null||!sd||!Number.isFinite(target))return null;
  return clamp(1-normalCdf((target-.5-center)/sd));
}
export function availabilityProbability(player,targetPick,currentPick=1,context={}){
  const target=Number(targetPick),current=Number(currentPick);
  if(!Number.isFinite(target)||!Number.isFinite(current))return .5;
  if(target<=current)return 1;
  // Returning 1 makes TE availability neutral in scoring and rollouts. It is
  // deliberately paired with low confidence so the UI never presents this as
  // a market survival forecast.
  if(String(player?.position||"").toUpperCase()==="TE")return 1;
  const targetSurvival=marketSurvival(player,target,context),currentSurvival=marketSurvival(player,current,context);
  if(targetSurvival==null||currentSurvival==null)return .5;
  if(currentSurvival<1e-9)return 0;
  return clamp(targetSurvival/currentSurvival);
}
// Use this after the user commits the selection at selectionPick. That occupied
// pick cannot remove another player from the board, so only subsequent opponent
// picks belong in the survival window. At a snake turn (for example 36 -> 37),
// there are no intervening selections and availability is therefore certain.
export function availabilityAfterSelection(player,targetPick,selectionPick,context={}){
  const selected=Number(selectionPick);
  if(!Number.isFinite(selected))return .5;
  return availabilityProbability(player,targetPick,selected+1,context);
}
