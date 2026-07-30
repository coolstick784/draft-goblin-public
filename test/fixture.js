import { normalizeSettings, snakeSlot } from "../shared/domain.js";
export function fixtureState({ teams = 4, rounds = 6, picked = 7 } = {}) {
  const positions = ["RB","WR","QB","TE","RB","WR","RB","WR","QB","TE","K","DST"];
  const players = Array.from({length: teams * rounds + 12}, (_, i) => ({ id: `p${i+1}`, name: `Player ${i+1}`, position: positions[i % positions.length], team: `T${i%32}`, mean: 240-i*3, ceiling: 290-i*2.5, floor: 150-i*2, risk: (i%7)/10, scarcity: positions[i%positions.length] === "RB" ? .8 : .45, adp: i+1, adpSd: 6 }));
  return { platform: "fixture", draftId: "fixture-1", dataQuality: "calibrated", settings: normalizeSettings({ teams, rounds, playoffTeams: 2, slots: { QB:1,RB:1,WR:1,TE:1,FLEX:1,K:0,DST:0,BENCH:1 } }), picks: players.slice(0,picked).map((p,i)=>({pickNo:i+1,playerId:p.id,slot:snakeSlot(i+1,teams)})), players, updatedAt: Date.now() };
}

export function shaheedPick128State(){
  const teams=12,rounds=11,userSlot=8,settings=normalizeSettings({teams,rounds,playoffTeams:6,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:7},scoring:{reception:0}}),userPicks=new Map([
    [8,["Amon-Ra St. Brown","WR",324]],[17,["Omarion Hampton","RB",279]],[32,["Travis Etienne","RB",241]],[41,["Josh Allen","QB",369]],[56,["Harold Fannin","TE",187]],[65,["Courtland Sutton","WR",204]],[80,["Tony Pollard","RB",190]],[89,["Rhamondre Stevenson","RB",191]],[104,["Xavier Worthy","WR",173]],[113,["Jacory Croskey-Merritt","RB",152]]
  ]),cycle=["RB","WR","RB","WR","QB","TE"],drafted=Array.from({length:120},(_,index)=>{const pickNo=index+1,[name,position,mean]=userPicks.get(pickNo)||[`Drafted Player ${pickNo}`,cycle[index%cycle.length],220-index*.45];return{id:`drafted-${pickNo}`,name,position,team:`T${index%32}`,mean,floor:mean*.72,ceiling:mean*1.28,risk:.35,scarcity:position==="RB"?.8:.55,adp:pickNo,adpSd:8,eligibleForRecommendation:true}}),candidate=(id,name,position,mean,floor,ceiling,adp,risk,scarcity)=>({id,name,position,team:"TEST",mean,floor,ceiling,adp,adpSd:14.5,risk,scarcity,eligibleForRecommendation:true}),candidates=[
    candidate("tracy","Tyrone Tracy","RB",114.6,77,167,132,.6,.8),
    candidate("sampson","Dylan Sampson","RB",99.2,82,135,180,.31,.8),
    candidate("shaheed","Rashid Shaheed","WR",145.9,126,195,190,.25,.55),
    candidate("allgeier","Tyler Allgeier","RB",87.1,75,117,125,.25,.8),
    candidate("boston","Denzel Boston","WR",130.2,79,196,185,.72,.55),
    candidate("rodriguez","Chris Rodriguez","RB",97.7,55,149,127,.6,.8),
    candidate("jennings","Jauan Jennings","WR",128.1,106,174,130,.31,.55),
    candidate("jeudy","Jerry Jeudy","WR",133.4,75,204,188,.25,.55)
  ],future=Array.from({length:20},(_,index)=>{const position=["RB","WR","QB","TE"][index%4],mean=1;return{id:`future-${index}`,name:`Future Player ${index}`,position,team:`F${index%32}`,mean,floor:.5,ceiling:2,risk:.4,scarcity:.1,adp:210+index,adpSd:12,eligibleForRecommendation:true}}),players=[...drafted,...candidates,...future],picks=drafted.map((player,index)=>({pickNo:index+1,playerId:player.id,slot:snakeSlot(index+1,teams)}));
  return{platform:"fixture",draftId:`shaheed-pick-128-${Date.now()}`,dataQuality:"calibrated",projectionSeason:2026,settings,picks,players,updatedAt:Date.now(),userSlot};
}

export function shaheedPick128OnClockState(){const state=shaheedPick128State(),fillers=state.players.filter(player=>String(player.id).startsWith("future-")).slice(0,7);state.picks.push(...fillers.map((player,index)=>({pickNo:121+index,playerId:player.id,slot:snakeSlot(121+index,state.settings.teams)})));state.draftId=`shaheed-on-clock-${Date.now()}`;return state}
