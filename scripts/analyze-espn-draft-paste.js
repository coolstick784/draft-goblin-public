import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { buildDraftReport } from "../core/post-draft-report.js";
import { snakeSlot } from "../shared/domain.js";
import { buildEspnState } from "./recommend-live-espn.js";

const BOARD_POSITION=/^(QB|RB|WR|TE|K|D\/ST|DST)$/;
const BOARD_TEAM=/^[A-Z]{2,4}$/;
const boardOwner=(value,userTeamPattern)=>/^Team \d+$/.test(value)||userTeamPattern.test(value);

function parseBoardPicks(text,{teams,userTeamPattern}){
  const boardStart=text.indexOf("\nAll Rounds\n"),picksStart=text.lastIndexOf("\nPicks\n");
  if(boardStart<0||picksStart<=boardStart)return[];
  const lines=text.slice(boardStart,picksStart).split("\n").map(line=>line.trim());
  const rows=[];
  for(let round=1;round<=16;round++){
    const roundIndex=lines.findIndex(line=>line===`Round ${round}`);
    if(roundIndex<0)continue;
    const nextRoundIndex=lines.findIndex((line,index)=>index>roundIndex&&/^Round \d+$/.test(line));
    const end=nextRoundIndex<0?lines.length:nextRoundIndex;
    let cursor=roundIndex+1;
    for(let roundPick=1;roundPick<=teams;roundPick++){
      const pickNo=(round-1)*teams+roundPick;
      let parsed=null;
      for(let index=cursor;index<end;index++){
        if(lines[index]!==String(pickNo))continue;
        const values=[];for(let scan=index+1;scan<Math.min(end,index+14);scan++)if(lines[scan])values.push({value:lines[scan],index:scan});
        const ownerAt=values.findIndex(row=>boardOwner(row.value,userTeamPattern));
        if(ownerAt<3)continue;
        const owner=values[ownerAt].value,position=values[ownerAt-1].value.replace("D/ST","DST"),team=values[ownerAt-2].value,name=values[0].value;
        if(!BOARD_POSITION.test(position)||!BOARD_TEAM.test(team)||/^[-+]?\d/.test(name))continue;
        parsed={pickNo,slot:snakeSlot(pickNo,teams),name,team,position,owner};
        cursor=values[ownerAt].index+1;
        break;
      }
      if(parsed)rows.push(parsed);
    }
  }
  return rows;
}

export function parseEspnDraftPaste(text,{teams=12,userTeamPattern=/we go's Wild Team/i}={}){
  text=String(text).replace(/\r\n?/g,"\n");
  const picksHeader=text.lastIndexOf("\nPicks\n");
  if(picksHeader<0)throw new Error("Could not find ESPN's Picks section.");
  const section=text.slice(picksHeader+7),pattern=/(.+)\s+\/\s+([A-Z-]+)\s+([^\r\n]+)\r?\nR(\d+),\s*P(\d+)\s*-\s*([^\r\n]+)/g;
  const picks=[];let match;
  while((match=pattern.exec(section))){
    const round=Number(match[4]),roundPick=Number(match[5]),pickNo=(round-1)*teams+roundPick,position=String(match[3]).split(",")[0].trim().replace("D/ST","DST");
    picks.push({pickNo,slot:snakeSlot(pickNo,teams),name:match[1].trim(),team:match[2].trim(),position,owner:match[6].trim()});
  }
  const byPickNo=new Map(picks.map(pick=>[pick.pickNo,pick]));
  for(const pick of parseBoardPicks(text,{teams,userTeamPattern}))if(!byPickNo.has(pick.pickNo)){picks.push(pick);byPickNo.set(pick.pickNo,pick)}
  picks.sort((a,b)=>a.pickNo-b.pickNo);
  if(picks.length!==teams*16)throw new Error(`Expected ${teams*16} picks, parsed ${picks.length}.`);
  const boardStart=Math.max(0,text.indexOf("\nAll Rounds\n")),boardText=text.slice(boardStart,picksHeader),boardHasRank=/(?:^|\n)RK(?:\n|$)/.test(boardText),boardLines=boardText.split("\n").map(line=>line.trim()).filter(Boolean);
  for(const pick of picks){const index=boardLines.findIndex(line=>line===pick.name),tail=index<0?[]:boardLines.slice(index+1,index+12),ownerIndex=tail.findIndex(line=>/^Team \d+$/.test(line)||userTeamPattern.test(line));if(ownerIndex>=0){const points=Number(tail[ownerIndex+2]),rank=boardHasRank?Number(tail[ownerIndex+3]):null;if(points>0)pick.platformPoints=points;if(rank>0)pick.rank=rank}}
  const userPick=picks.find(pick=>userTeamPattern.test(pick.owner));
  if(!userPick)throw new Error("Could not identify the user's team in the ESPN paste.");
  const limits=text.match(/QB\d+\/(\d+)RB\d+\/(\d+)WR\d+\/(\d+)TE\d+\/(\d+)K\d+\/(\d+)D\/ST\d+\/(\d+)/i),positionLimits=limits?{QB:Number(limits[1]),RB:Number(limits[2]),WR:Number(limits[3]),TE:Number(limits[4]),K:Number(limits[5]),DST:Number(limits[6])}:{};
  return{teams,rounds:picks.length/teams,userSlot:userPick.slot,picks,positionLimits};
}

export function analyzeEspnDraftPaste(text,{iterations=10000,teams=12}={}){const parsed=parseEspnDraftPaste(text,{teams}),state=buildEspnState({...parsed,draftId:`espn-paste-${Date.now()}`}),report=buildDraftReport({state,userSlot:parsed.userSlot,iterations,seed:2026}),user=report.userTeam,hindsight=report.decisionAudit.hindsight;return{
  report:{teams:report.teams,userSlot:report.userSlot,iterations:report.iterations,titleRank:user.titleRank,weeklyRank:user.weeklyRank,titleChance:user.finishProbabilities[0],weeklyPoints:user.pointsExact,grade:report.grade,model:report.simulationModelVersion},
  roster:user.draft,
  standings:[...report.teamReports].sort((a,b)=>a.titleRank-b.titleRank).map(team=>({slot:team.slot,titleRank:team.titleRank,weeklyRank:team.weeklyRank,titleChance:team.finishProbabilities[0],weeklyPoints:team.pointsExact})),
  hindsight:{iterations:hindsight.auditIterations,eligible:hindsight.eligibleSwapAlternatives,evaluated:hindsight.evaluatedAlternatives,route:hindsight.route,top:hindsight.alternatives.slice(0,12)}
}}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const inputPath=process.argv[2],iterations=Number(process.argv[3]||10000);if(!inputPath)throw new Error("Usage: node scripts/analyze-espn-draft-paste.js <paste.txt> [iterations]");console.log(JSON.stringify(analyzeEspnDraftPaste(fs.readFileSync(inputPath,"utf8"),{iterations}),null,2))}
