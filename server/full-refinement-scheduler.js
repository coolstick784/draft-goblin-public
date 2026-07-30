const cancelledError=()=>Object.assign(new Error("full refinement cancelled"),{code:"REFINEMENT_CANCELLED"});

export class FullRefinementScheduler{
  #active=null;
  #queued=[];
  #sequence=0;

  schedule(key,run,{priority=0,metadata={},onCancel=()=>{},preemptLowerPriority=false}={}){
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no}),entry={key,run,priority:Number(priority)||0,metadata,sequence:this.#sequence++,state:"queued",cancelled:false,onCancel,resolve,reject,promise};
    this.#queued.push(entry);
    if(preemptLowerPriority&&this.#active&&entry.priority>this.#active.priority)this.#cancel(this.#active);
    this.#drain();
    return{promise,cancel:()=>this.#cancel(entry),state:()=>entry.state};
  }

  stateFor(key){
    if(this.#active?.key===key)return"active";
    return this.#queued.some(entry=>entry.key===key)?"queued":null;
  }

  stats(){
    const describe=entry=>entry?{priority:entry.priority,state:entry.state,...entry.metadata}:null;
    return{activeCount:this.#active?1:0,queuedCount:this.#queued.length,active:describe(this.#active),queued:this.#queued.slice(0,8).map(describe)};
  }

  #cancel(entry){
    if(entry.cancelled||entry.state==="settled")return;
    entry.cancelled=true;
    entry.onCancel();
    if(entry.state==="queued"){
      const index=this.#queued.indexOf(entry);
      if(index>=0)this.#queued.splice(index,1);
      entry.state="settled";
      entry.reject(cancelledError());
      this.#drain();
    }
  }

  #drain(){
    if(this.#active)return;
    this.#queued=this.#queued.filter(entry=>!entry.cancelled&&entry.state==="queued");
    if(!this.#queued.length)return;
    this.#queued.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
    const entry=this.#queued.shift();
    this.#active=entry;entry.state="active";
    Promise.resolve().then(()=>entry.run()).then(entry.resolve,entry.reject).finally(()=>{
      entry.state="settled";
      if(this.#active===entry)this.#active=null;
      this.#drain();
    });
  }
}
