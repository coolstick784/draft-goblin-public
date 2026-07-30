(()=>{
  if(globalThis.__draftGoblinLauncher)return;

  const state={lastUrl:"",dismissedUrl:"",host:null,shadow:null,button:null,dismiss:null,status:null,statusTimer:null,panelOpen:false,panelVisibilityKnown:true};
  globalThis.__draftGoblinLauncher=state;

  function draftPlatform(value=location.href){
    let url;try{url=new URL(value,location.href)}catch{return null}
    const host=url.hostname.toLowerCase();
    if(/^(?:www\.)?(?:sleeper\.com|sleeper\.app)$/.test(host)){
      const queryId=url.searchParams.get("draft_id"),pathId=[...url.pathname.matchAll(/(?:^|\/)([0-9]{10,})(?=\/|$)/g)].at(-1)?.[1];
      if(/^\d{10,}$/.test(String(queryId||pathId||"")))return"sleeper";
    }
    if(host==="fantasy.espn.com"&&/^\/football\/draft\/?$/i.test(url.pathname)&&/^\d+$/.test(String(url.searchParams.get("leagueId")||"")))return"espn";
    return null;
  }
  function setStatus(message,isError=false){
    if(!state.status)return;clearTimeout(state.statusTimer);state.status.textContent=message;state.status.dataset.error=String(isError);
    state.statusTimer=setTimeout(()=>{if(state.status)state.status.textContent=""},3500);
  }
  async function openPanel(source){
    try{
      const response=await chrome.runtime.sendMessage({type:"OPEN_DRAFT_SIDE_PANEL",source,platform:draftPlatform()});
      if(response?.ok!==true)throw new Error(response?.error||"Draft Goblin could not open.");
      state.panelOpen=true;state.panelVisibilityKnown=true;removeLauncher();return true;
    }catch(error){setStatus("Click the extension icon to open Draft Goblin",true);return false}
  }
  function removeLauncher(){state.host?.remove?.();state.host=null;state.shadow=null;state.button=null;state.dismiss=null;state.status=null;clearTimeout(state.statusTimer)}
  function mountLauncher(){
    if(state.host?.isConnected)return;
    const host=document.createElement("div");host.id="draft-goblin-launcher";host.setAttribute("data-draft-goblin-ui","");
    const shadow=host.attachShadow({mode:"open"});
    shadow.innerHTML=`<style>:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:6px}.actions{display:flex;align-items:center;gap:6px}.open,.dismiss{appearance:none;border:1px solid #b9e65b;background:#17210f;color:#f7ffe8;box-shadow:0 8px 28px #0007;cursor:pointer;font:700 14px/1 system-ui}.open{border-radius:999px;padding:12px 16px}.dismiss{display:grid;place-items:center;width:34px;height:34px;border-color:#71805f;border-radius:50%;font-size:18px}.open:hover,.dismiss:hover{background:#223316}.open:focus-visible,.dismiss:focus-visible{outline:3px solid #d8ff83;outline-offset:3px}.status{min-height:16px;max-width:260px;border-radius:6px;background:#17210f;color:#e9ffc2;font:600 12px/1.3 system-ui;padding:0 7px}.status:empty{padding:0}.status[data-error="true"]{color:#ffe0b5}@media(max-width:520px){:host{right:8px;bottom:8px}.open{padding:10px 12px}}</style><div class="wrap"><div class="status" role="status" aria-live="polite"></div><div class="actions"><button class="open" type="button" aria-label="Open Draft Goblin side panel">Open Draft Goblin</button><button class="dismiss" type="button" aria-label="Dismiss Draft Goblin launcher">×</button></div></div>`;
    state.host=host;state.shadow=shadow;state.button=shadow.querySelector(".open");state.dismiss=shadow.querySelector(".dismiss");state.status=shadow.querySelector(".status");state.button.addEventListener("click",()=>openPanel("draft-page-launcher"));state.dismiss.addEventListener("click",()=>{state.dismissedUrl=location.href;removeLauncher()});
    (document.body||document.documentElement)?.append(host);
  }
  function sync(){
    const url=location.href,shouldMount=state.panelVisibilityKnown&&!state.panelOpen&&Boolean(draftPlatform(url))&&state.dismissedUrl!==url;if(url===state.lastUrl&&Boolean(state.host?.isConnected)===shouldMount)return;
    state.lastUrl=url;shouldMount?mountLauncher():removeLauncher();
  }
  async function refreshPanelVisibility(){
    try{const response=await chrome.runtime.sendMessage({type:"GET_DRAFT_SIDE_PANEL_VISIBILITY"});state.panelOpen=response?.open===true}
    catch{state.panelOpen=false}
    state.panelVisibilityKnown=true;sync();
  }

  chrome.runtime.onMessage?.addListener(message=>{if(message.type!=="DRAFT_SIDE_PANEL_VISIBILITY")return;state.panelOpen=message.open===true;state.panelVisibilityKnown=true;sync()});
  addEventListener("popstate",sync);addEventListener("hashchange",sync);
  new MutationObserver(sync).observe(document.documentElement,{childList:true,subtree:true});
  setInterval(sync,1000);sync();refreshPanelVisibility();
})();
