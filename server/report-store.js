import fs from "node:fs";
import {repairStoredDecisionAudit} from "../core/post-draft-report.js";

const validId=id=>/^[a-zA-Z0-9-]{1,80}$/.test(String(id||""));

export class PersistentReportStore{
  constructor({directory=new URL("../data/reports/",import.meta.url),memoryLimit=100}={}){
    this.directory=directory;
    this.memoryLimit=memoryLimit;
    this.memory=new Map();
  }

  path(reportId){
    if(!validId(reportId))return null;
    return new URL(`${reportId}.json`,this.directory);
  }

  set(reportId,report){
    const path=this.path(reportId);
    if(!path)throw new Error("invalid draft report id");
    const entry={report:repairStoredDecisionAudit(report),at:Date.now()};
    this.memory.set(reportId,entry);
    while(this.memory.size>this.memoryLimit)this.memory.delete(this.memory.keys().next().value);
    fs.mkdirSync(this.directory,{recursive:true});
    const temporary=new URL(`${reportId}.${process.pid}.tmp`,this.directory);
    fs.writeFileSync(temporary,JSON.stringify(entry));
    fs.renameSync(temporary,path);
    return entry;
  }

  get(reportId){
    if(!validId(reportId))return null;
    const cached=this.memory.get(reportId);
    if(cached){repairStoredDecisionAudit(cached.report);return cached}
    const path=this.path(reportId);
    if(!path||!fs.existsSync(path))return null;
    try{
      const entry=JSON.parse(fs.readFileSync(path,"utf8"));
      if(!entry?.report||!Number.isFinite(Number(entry.at)))return null;
      repairStoredDecisionAudit(entry.report);
      this.memory.set(reportId,entry);
      while(this.memory.size>this.memoryLimit)this.memory.delete(this.memory.keys().next().value);
      return entry;
    }catch{return null}
  }
}
