import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { recommend } from "../core/recommend.js";
import { evaluateDraft } from "../core/evaluate.js";
import { normalizeSettings } from "../shared/domain.js";

const draft=JSON.parse(fs.readFileSync(new URL("../data/generated/live-draft.json",import.meta.url)));
const picksRaw=JSON.parse(fs.readFileSync(new URL("../data/generated/live-draft-picks.json",import.meta.url)));
const rows=JSON.parse(fs.readFileSync(new URL("../data/generated/sleeper-current-projections.json",import.meta.url)));
const catalog=JSON.parse(fs.readFileSync(new URL("../data/generated/sleeper-current-catalog.json",import.meta.url)));
const reception=draft.metadata?.scoring_type==="ppr"?1:draft.metadata?.scoring_type==="half_ppr"?.5:0;
const positions=new Set(["QB","RB","WR","TE","K","DEF"]);
const players=rows.filter(row=>positions.has(row.player?.position)).map(row=>{
  const stats=row.stats||{},position=row.player.position==="DEF"?"DST":row.player.position,mean=Number(reception>=.75?stats.pts_ppr:reception>=.25?stats.pts_half_ppr:stats.pts_std)||0,adp=Number(reception>=.75?stats.adp_ppr:reception>=.25?stats.adp_half_ppr:stats.adp_std),cat=catalog[String(row.player_id)]||{};
  return{id:String(row.player_id),name:cat.full_name||`${row.player.first_name||""} ${row.player.last_name||""}`.trim(),position,team:row.player.team,mean,floor:mean*.78,ceiling:mean*1.28,risk:cat.injury_status?.8:.25,scarcity:["RB","TE"].includes(position)?.65:.4,adp:Number.isFinite(adp)&&adp>0&&adp<900?adp:null,adpSd:18,eligibleForRecommendation:mean>0};
});
const byId=new Set(players.map(player=>player.id));
for(const pick of picksRaw)if(!byId.has(String(pick.player_id))){const metadata=pick.metadata||{},position=metadata.position==="DEF"?"DST":metadata.position;players.push({id:String(pick.player_id),name:`${metadata.first_name||""} ${metadata.last_name||""}`.trim()||String(pick.player_id),position,team:metadata.team||null,mean:0,floor:0,ceiling:0,risk:1,scarcity:0,adp:null,adpSd:30,eligibleForRecommendation:false})}
const settings=normalizeSettings({teams:draft.settings.teams,rounds:draft.settings.rounds,playoffTeams:6,scoring:{reception},slots:{QB:draft.settings.slots_qb||1,RB:draft.settings.slots_rb||2,WR:draft.settings.slots_wr||2,TE:draft.settings.slots_te||1,FLEX:draft.settings.slots_flex||1,K:draft.settings.slots_k||0,DST:draft.settings.slots_def||0,BENCH:draft.settings.slots_bn||6}});
const state={platform:"sleeper",draftId:draft.draft_id,projectionSeason:Number(draft.season),userSlot:10,settings,picks:picksRaw.map(p=>({pickNo:Number(p.pick_no),playerId:String(p.player_id),slot:Number(p.draft_slot)})),players,updatedAt:Date.now()};
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=recommend({state,userSlot:10,strategy:"balanced",limit:12}),evaluated=evaluateDraft({state,userSlot:10,strategy:"balanced",iterations:2000});console.log(JSON.stringify({pick:state.picks.length+1,userSlot:10,evaluated:evaluated.slice(0,8).map(item=>({name:item.player.name,position:item.player.position,titleChance:Number((item.simulation.championshipProbability*100).toFixed(1)),tie:item.statisticalTie})),recommendations:result.map(item=>({name:item.player.name,position:item.player.position,adp:item.player.adp,points:item.player.mean,score:Number(item.planScore.toFixed(3)),reach:Number(item.marketReachPenalty.toFixed(3)),nextAvailability:Number(item.nextPickAvailability.toFixed(3))}))},null,2))}
export{state};
