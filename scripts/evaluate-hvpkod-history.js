import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const POSITIONS=new Set(["QB","RB","WR","TE","K"]);
const finite=value=>Number.isFinite(Number(value));

export function loadHvpkod(root){
  const rows=[];
  for(const yearEntry of fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^20\d\d$/.test(entry.name))){
    const year=Number(yearEntry.name),yearPath=path.join(root,yearEntry.name);
    for(const weekEntry of fs.readdirSync(yearPath,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^\d+$/.test(entry.name))){
      const week=Number(weekEntry.name),projectedPath=path.join(yearPath,weekEntry.name,"projected");
      if(!fs.existsSync(projectedPath))continue;
      for(const file of fs.readdirSync(projectedPath).filter(name=>/^(QB|RB|WR|TE|K)_projected\.json$/.test(name))){
        const position=file.slice(0,file.indexOf("_"));if(!POSITIONS.has(position))continue;
        for(const row of JSON.parse(fs.readFileSync(path.join(projectedPath,file),"utf8"))){
          if(!finite(row.PlayerWeekProjectedPts)||!finite(row.TotalPoints)||Number(row.PlayerWeekProjectedPts)<=0)continue;
          // TotalPoints is an outcome used only after the projection has been selected.
          rows.push({sourceId:"hvpkod-fantasy-nfl",year,week,playerId:String(row.PlayerId||""),name:row.PlayerName,position,projected:Number(row.PlayerWeekProjectedPts),actual:Number(row.TotalPoints)});
        }
      }
    }
  }
  return rows;
}

function metrics(rows){const errors=rows.map(row=>row.projected-row.actual),mae=errors.reduce((sum,error)=>sum+Math.abs(error),0)/rows.length,rmse=Math.sqrt(errors.reduce((sum,error)=>sum+error*error,0)/rows.length),bias=errors.reduce((sum,error)=>sum+error,0)/rows.length;return{rows:rows.length,mae:Number(mae.toFixed(4)),rmse:Number(rmse.toFixed(4)),bias:Number(bias.toFixed(4))}}

export function evaluateHvpkod(root){const rows=loadHvpkod(root),years=[...new Set(rows.map(row=>row.year))].sort(),positions=[...POSITIONS],holdoutYear=years.at(-1),calibrationRows=rows.filter(row=>row.year<holdoutYear),holdoutRows=rows.filter(row=>row.year===holdoutYear);return{generatedAt:new Date().toISOString(),source:"hvpkod/NFL-Data",license:"MIT repository license; underlying Fantasy.NFL.com data rights remain with their respective owner",method:"Weekly PlayerWeekProjectedPts evaluated against later TotalPoints. Team and opponent fields are ignored. Zero/blank projections are excluded.",leakageBoundary:"Only PlayerWeekProjectedPts and player identity fields are projection inputs; TotalPoints is used solely as the post-week outcome.",coverage:{rows:rows.length,years},overall:metrics(rows),byYear:Object.fromEntries(years.map(year=>[year,metrics(rows.filter(row=>row.year===year))])),byPosition:Object.fromEntries(positions.map(position=>[position,metrics(rows.filter(row=>row.position===position))])),walkForward:{calibrationYears:years.slice(0,-1),holdoutYear,calibration:metrics(calibrationRows),holdout:metrics(holdoutRows),calibrationByPosition:Object.fromEntries(positions.map(position=>[position,metrics(calibrationRows.filter(row=>row.position===position))]))}}}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const root=process.argv[2]||"data/vendor/NFL-Data-main/NFL-data-Players",output=process.argv[3]||"data/research/hvpkod-projection-accuracy.json",report=evaluateHvpkod(root);fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2))}
