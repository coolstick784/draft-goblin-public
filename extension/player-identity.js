const NAME_ALIASES=new Map(Object.entries({
  gabedavis:"gabrieldavis",
  hollywoodbrown:"marquisebrown",
  chigokonkwo:"chigoziemokonkwo",
  tankdell:"nathanieldell",
  mitchtrubisky:"mitchelltrubisky",
  joshpalmer:"joshuapalmer",
  kenwalker:"kennethwalker",
}));

const DEFENSE_ALIASES=new Map(Object.entries({
  ari:"ARI",arizona:"ARI",arizonacardinals:"ARI",cardinals:"ARI",
  atl:"ATL",atlanta:"ATL",atlantafalcons:"ATL",falcons:"ATL",
  bal:"BAL",baltimore:"BAL",baltimoreravens:"BAL",ravens:"BAL",
  buf:"BUF",buffalo:"BUF",buffalobills:"BUF",bills:"BUF",
  car:"CAR",carolina:"CAR",carolinapanthers:"CAR",panthers:"CAR",
  chi:"CHI",chicago:"CHI",chicagobears:"CHI",bears:"CHI",
  cin:"CIN",cincinnati:"CIN",cincinnatibengals:"CIN",bengals:"CIN",
  cle:"CLE",cleveland:"CLE",clevelandbrowns:"CLE",browns:"CLE",
  dal:"DAL",dallas:"DAL",dallascowboys:"DAL",cowboys:"DAL",
  den:"DEN",denver:"DEN",denverbroncos:"DEN",broncos:"DEN",
  det:"DET",detroit:"DET",detroitlions:"DET",lions:"DET",
  gb:"GB",greenbay:"GB",greenbaypackers:"GB",packers:"GB",
  hou:"HOU",houston:"HOU",houstontexans:"HOU",texans:"HOU",
  ind:"IND",indianapolis:"IND",indianapoliscolts:"IND",colts:"IND",
  jax:"JAX",jac:"JAX",jacksonville:"JAX",jacksonvillejaguars:"JAX",jaguars:"JAX",
  kc:"KC",kansascity:"KC",kansascitychiefs:"KC",chiefs:"KC",
  lv:"LV",lasvegas:"LV",lasvegasraiders:"LV",oaklandraiders:"LV",raiders:"LV",
  lac:"LAC",losangeleschargers:"LAC",sandiegochargers:"LAC",chargers:"LAC",
  lar:"LAR",losangelesrams:"LAR",stlouisrams:"LAR",rams:"LAR",
  mia:"MIA",miami:"MIA",miamidolphins:"MIA",dolphins:"MIA",
  min:"MIN",minnesota:"MIN",minnesotavikings:"MIN",vikings:"MIN",
  ne:"NE",newengland:"NE",newenglandpatriots:"NE",patriots:"NE",
  no:"NO",neworleans:"NO",neworleanssaints:"NO",saints:"NO",
  nyg:"NYG",newyorkgiants:"NYG",giants:"NYG",
  nyj:"NYJ",newyorkjets:"NYJ",jets:"NYJ",
  phi:"PHI",philadelphia:"PHI",philadelphiaeagles:"PHI",eagles:"PHI",
  pit:"PIT",pittsburgh:"PIT",pittsburghsteelers:"PIT",steelers:"PIT",
  sea:"SEA",seattle:"SEA",seattleseahawks:"SEA",seahawks:"SEA",
  sf:"SF",sanfrancisco:"SF",sanfrancisco49ers:"SF","49ers":"SF",fortyniners:"SF",niners:"SF",
  tb:"TB",tampabay:"TB",tampabaybuccaneers:"TB",buccaneers:"TB",bucs:"TB",
  ten:"TEN",tennessee:"TEN",tennesseetitans:"TEN",titans:"TEN",
  was:"WAS",wsh:"WAS",washington:"WAS",washingtoncommanders:"WAS",washingtonfootballteam:"WAS",commanders:"WAS",
}));

const ascii=value=>String(value||"").normalize("NFKD").replace(/[^\x00-\x7F]/g,"");
const compact=value=>ascii(value).toLowerCase().replace(/\b(?:jr|sr|ii|iii|iv|v)\.?\s*$/i,"").replace(/[^a-z0-9]/g,"");
const literalName=value=>ascii(value).toLowerCase().replace(/[^a-z0-9]/g,"");
const position=value=>String(value||"").toUpperCase().replace("D/ST","DST").replace("DEF","DST");
const marketRank=value=>{const rank=Number(value);return Number.isFinite(rank)&&rank>0&&rank<500?rank:null};

function duplicateIdentityMatch(matches,player){
  if(matches.length<2)return matches[0]||null;
  const teams=new Set(matches.map(candidate=>String(candidate?.team||"").toUpperCase()).filter(Boolean)),positions=new Set(matches.map(candidate=>position(candidate?.position)).filter(value=>value&&value!=="NA"));
  // Different teams or positions can represent genuine namesakes. Only choose
  // deterministically when every row describes the same football identity.
  if(teams.size>1||positions.size>1)return null;
  const wantedTeam=String(player?.team||"").toUpperCase();if(wantedTeam&&teams.size===1&&![...teams].includes(wantedTeam))return null;
  const wantedName=literalName(player?.name),score=candidate=>(literalName(candidate?.name)===wantedName?100:0)+(candidate?.eligibleForRecommendation===true?16:0)+(Number(candidate?.platformProjection)>0?8:0)+(marketRank(candidate?.adp)!==null?4:0)+(candidate?.team?2:0)+(position(candidate?.position)!=="NA"?1:0);
  return[...matches].sort((left,right)=>score(right)-score(left)||String(left?.id||"").localeCompare(String(right?.id||"")))[0]||null;
}

export function playerIdentityKey(value){
  const raw=compact(typeof value==="object"?value?.name:value);
  return NAME_ALIASES.get(raw)||raw;
}

function defenseCode(player){
  const listedPosition=position(player?.position);
  // ESPN's virtualized completed-draft rows sometimes omit position metadata for
  // a defense and expose only its franchise/display name. Treat an absent/NA
  // position as unknown, not as evidence that the row is not a defense. A known
  // non-defense position still fails closed so an ordinary player cannot join a
  // franchise merely because of a loose name match.
  if(listedPosition&&listedPosition!=="NA"&&listedPosition!=="DST")return"";
  const team=compact(player?.team),name=compact(player?.name).replace(/(?:dst|defense)$/i,"");
  return DEFENSE_ALIASES.get(team)||DEFENSE_ALIASES.get(name)||"";
}

export function playerIdentityKeys(player){
  const name=playerIdentityKey(player),pos=position(player?.position),keys=[];
  if(name){keys.push(`name:${name}`);if(pos)keys.push(`name-position:${name}:${pos}`)}
  const defense=defenseCode(player);if(defense)keys.unshift(`defense:${defense}`);
  return[...new Set(keys)];
}

export function buildPlayerIdentityIndex(players=[]){
  const index=new Map();
  for(const player of players)for(const key of playerIdentityKeys(player)){const matches=index.get(key)||[];matches.push(player);index.set(key,matches)}
  return index;
}

export function matchPlayerIdentity(index,player){
  for(const key of playerIdentityKeys(player)){
    let matches=index.get(key)||[];
    const wanted=position(player?.position);
    if(wanted&&wanted!=="NA")matches=matches.filter(candidate=>{const candidatePosition=position(candidate?.position);return candidatePosition===wanted||key.startsWith("defense:")&&wanted==="DST"&&(!candidatePosition||candidatePosition==="NA")});
    if(matches.length>1&&player?.team){const team=String(player.team).toUpperCase(),sameTeam=matches.filter(candidate=>String(candidate?.team||"").toUpperCase()===team);if(sameTeam.length===1)return sameTeam[0];if(sameTeam.length>1)matches=sameTeam}
    const duplicate=duplicateIdentityMatch(matches,player);if(duplicate)return duplicate;
    if(matches.length===1)return matches[0];
  }
  return null;
}
