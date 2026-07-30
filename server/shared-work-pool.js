export class SharedWorkPool{
  #entries=new Map();

  acquire(key,factory){
    let entry=this.#entries.get(key);
    if(!entry){
      const operation=factory(),subscribers=new Set();
      entry={key,operation,subscribers,settled:false};
      this.#entries.set(key,entry);
      Promise.resolve(operation.promise).finally(()=>{
        entry.settled=true;
        if(this.#entries.get(key)===entry)this.#entries.delete(key);
      }).catch(()=>{});
    }
    const subscriber=Symbol(key);
    entry.subscribers.add(subscriber);
    let released=false;
    return{
      promise:entry.operation.promise,
      operation:entry.operation,
      release:()=>{
        if(released)return;
        released=true;
        entry.subscribers.delete(subscriber);
        if(!entry.settled&&!entry.subscribers.size){
          entry.operation.cancel?.();
          if(this.#entries.get(key)===entry)this.#entries.delete(key);
        }
      }
    }
  }

  stats(){
    return{activeWorkCount:this.#entries.size,subscriberCount:[...this.#entries.values()].reduce((sum,entry)=>sum+entry.subscribers.size,0)}
  }
}
