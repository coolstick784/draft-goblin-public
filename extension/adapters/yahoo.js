(async function yahooAdapter() {
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const numberOr = (value, fallback = null) => {
    const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : fallback;
  };
  const snakeSlot = (pickNo, teams) => {
    const round = Math.floor((pickNo - 1) / teams) + 1;
    const within = ((pickNo - 1) % teams) + 1;
    return round % 2 ? within : teams + 1 - within;
  };
  const yahooDraftInfo = (value = "") => {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.hostname.toLowerCase() !== "football.fantasysports.yahoo.com") return null;
    const match = url.pathname.match(/^\/draftclient\/f1\/(\d+)\/(\d+)(?:\/|$)/i);
    return match ? { draftId: match[1], userSlot: Number(match[2]) } : null;
  };
  const positionFromText = value => {
    const text = clean(value).toUpperCase().replace(/D\/ST|DEFENSE|DEF/, "DST");
    if (/^QB\b|QUARTERBACK/.test(text)) return "QB";
    if (/^RB\b|RUNNING BACK/.test(text)) return "RB";
    if (/^WR\b|WIDE RECEIVER/.test(text)) return "WR";
    if (/^TE\b|TIGHT END/.test(text)) return "TE";
    if (/^K\b|KICKER/.test(text)) return "K";
    if (/^DST\b|TEAM DEFENSE/.test(text)) return "DST";
    return "";
  };
  const receptionValue = text => /\bhalf(?:[-\s]?point)?[-\s]?ppr\b|\b0\.5\s*ppr\b/i.test(clean(text)) ? .5 : /\bppr\b|\bpoint(?:s)? per reception\b/i.test(clean(text)) ? 1 : 0;
  const settingsFromRoster = ({ teams, rounds, labels, scoringText = "" }) => {
    const normalized = (labels || []).map(label => clean(label).toUpperCase()).filter(Boolean);
    const count = label => normalized.filter(value => value === label).length;
    const slots = {
      QB: count("QB"), RB: count("RB"), WR: count("WR"), TE: count("TE"),
      FLEX: count("FLEX") + count("W") + count("R") + count("T"),
      K: count("K"), DST: count("DEF") + count("DST") + count("D/ST"), BENCH: count("BN") + count("BE")
    };
    const teamCount = Number(teams), roundCount = Number(rounds) || normalized.length;
    if (!Number.isInteger(teamCount) || teamCount < 2 || !Number.isInteger(roundCount) || roundCount < 1) return null;
    const rosterCount = Object.values(slots).reduce((sum, value) => sum + value, 0);
    if (!rosterCount || rosterCount !== roundCount) return null;
    const starters = slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.K + slots.DST;
    return {
      teams: teamCount, rounds: roundCount, slots,
      positionLimits: {
        QB: Math.max(1, slots.QB + 1), RB: Math.max(2, slots.RB + Math.ceil(slots.FLEX * .75)),
        WR: Math.max(2, slots.WR + Math.ceil(slots.FLEX * .75)), TE: Math.max(1, slots.TE + 1),
        K: Math.max(1, slots.K), DST: Math.max(1, slots.DST)
      },
      scoring: { reception: receptionValue(scoringText), passTd: 4, rushTd: 6, receiveTd: 6 },
      playoffTeams: Math.min(6, teamCount), starterCount: starters
    };
  };
  const settingsFromYahooService = service => {
    const positions = service?.settings?.roster_positions || [], labels = [];
    for (const row of positions) {
      const raw = clean(row?.position).toUpperCase(), count = Math.max(0, Number(row?.count) || 0);
      const label = raw === "W/R/T" || raw === "W/R" || raw === "W/T" || raw === "Q/W/R/T" || raw === "FLEX" ? "FLEX" : raw === "DEF" || raw === "D/ST" ? "DST" : raw === "BN" || raw === "BE" ? "BN" : raw;
      for (let index = 0; index < count; index++) labels.push(label);
    }
    const teams = Number(service?.num_teams), settings = settingsFromRoster({ teams, rounds: labels.length, labels });
    if (!settings) return null;
    const categories = service?.settings?.stat_categories || [], modifier = id => Number(categories.find(row => Number(row?.stat_id) === id)?.stat_modifier);
    return { ...settings, scoring: { reception: Number.isFinite(modifier(11)) ? modifier(11) : 0, passTd: Number.isFinite(modifier(5)) ? modifier(5) : 4, rushTd: Number.isFinite(modifier(10)) ? modifier(10) : 6, receiveTd: Number.isFinite(modifier(13)) ? modifier(13) : 6 } };
  };
  const normalizePlayers = (rows, season = new Date().getFullYear()) => {
    const byId = new Map();
    for (const row of rows || []) {
      const id = clean(row?.id || row?.playerId), name = clean(row?.name);
      if (!id || !name) continue;
      const position = positionFromText(row?.position);
      if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(position)) continue;
      const projection = numberOr(row?.platformProjection, 0) || 0, adp = numberOr(row?.adp);
      const player = {
        id, platformPlayerId: id, name, position, team: clean(row?.team) || "FA", active: row?.active !== false,
        platformProjection: projection, projectionSeason: Number(season),
        projectionSource: projection > 0 ? clean(row?.projectionSource) || "Yahoo visible draft projection" : "unavailable",
        adp: Number.isFinite(adp) && adp > 0 && adp < 500 ? adp : null,
        adpSource: Number.isFinite(adp) && adp > 0 && adp < 500 ? "yahoo-draft-adp" : "unavailable",
        adpSd: null, adpSdSource: "rank-calibrated", adpSeason: Number(season), adpProvider: "yahoo", adpFetchedAt: Date.now(),
        risk: row?.injuryStatus ? .8 : .25, scarcity: ["RB", "TE"].includes(position) ? .65 : .4,
        eligibleForRecommendation: row?.active !== false && Boolean(clean(row?.team)) && clean(row?.team) !== "FA"
      };
      const previous = byId.get(id);
      byId.set(id, previous ? { ...previous, ...player, platformProjection: Math.max(Number(previous.platformProjection) || 0, projection) } : player);
    }
    return [...byId.values()];
  };
  const catalogRowsFromService = service => (service?.player_list || []).map(player => ({
    id: player?.id,
    name: clean(`${player?.fname || ""} ${player?.lname || ""}`),
    position: player?.display_pos || player?.primary_pos || player?.pos?.[0],
    team: player?.team_abbr,
    adp: player?.["average-pick"],
    platformProjection: player?.projected?.points,
    injuryStatus: player?.inj,
    projectionSource: "Yahoo official draft projection"
  }));
  const mergePlayerPool = (catalogPlayers, visiblePlayers, picks) => {
    const drafted = new Set((picks || []).map(pick => clean(pick?.playerId || pick?.id)).filter(Boolean)), byId = new Map();
    for (const player of catalogPlayers || []) {
      if (!player?.id || (Number(player.platformProjection) <= 0 && !drafted.has(player.id))) continue;
      byId.set(player.id, { ...player });
    }
    for (const player of visiblePlayers || []) {
      if (!player?.id) continue;
      const official = byId.get(player.id);
      byId.set(player.id, official ? {
        ...official, ...player,
        platformProjection: Math.max(Number(official.platformProjection) || 0, Number(player.platformProjection) || 0),
        projectionSource: Number(official.platformProjection) >= Number(player.platformProjection) ? official.projectionSource : player.projectionSource
      } : { ...player });
    }
    for (const pick of picks || []) {
      const id = clean(pick?.playerId || pick?.id), player = byId.get(id);
      if (player) byId.set(id, { ...player, eligibleForRecommendation: false });
    }
    return [...byId.values()];
  };
  const normalizePicks = (rows, teams) => {
    const byPick = new Map();
    for (const row of rows || []) {
      const pickNo = Number(row?.pickNo), playerId = clean(row?.playerId || row?.id);
      if (!Number.isInteger(pickNo) || pickNo < 1 || !playerId) continue;
      const pick = { pickNo, playerId, slot: Number(row?.slot) || snakeSlot(pickNo, Number(teams)), name: clean(row?.name), position: positionFromText(row?.position), team: clean(row?.team) };
      const prior = byPick.get(pickNo);
      if (prior && (prior.playerId !== pick.playerId || Number(prior.slot) !== Number(pick.slot))) return { error: `Yahoo pick ${pickNo} was reported with conflicting players.`, picks: [] };
      if (!prior) byPick.set(pickNo, pick);
    }
    const picks = [...byPick.values()].sort((left, right) => left.pickNo - right.pickNo);
    if (picks.some((pick, index) => pick.pickNo !== index + 1)) return { error: "Yahoo pick history is not contiguous yet.", picks: [] };
    return { error: "", picks };
  };
  const mergePickRows = (priorRows, visibleRows, teams) => normalizePicks([...(priorRows || []), ...(visibleRows || [])], teams);
  const appendContiguousPicks = (priorRows, visibleRows, teams) => {
    const retained = [...(priorRows || [])], visible = new Map();
    for (const row of visibleRows || []) {
      const pickNo = Number(row?.pickNo), playerId = clean(row?.playerId || row?.id);
      if (!Number.isInteger(pickNo) || pickNo < 1 || !playerId || visible.has(pickNo)) continue;
      visible.set(pickNo, { pickNo, playerId, slot: Number(row?.slot) || snakeSlot(pickNo, Number(teams)), name: clean(row?.name), position: positionFromText(row?.position), team: clean(row?.team) });
    }
    for (let next = retained.length + 1; visible.has(next); next++) retained.push(visible.get(next));
    return retained;
  };
  const currentPickFromTexts = (texts, teams) => {
    for (const value of texts || []) {
      const header = clean(value).match(/round\s+(\d+)\s*,\s*pick\s+(\d+)/i);
      const round = Number(header?.[1]), within = Number(header?.[2]);
      if (Number.isInteger(round) && round > 0 && Number.isInteger(within) && within > 0 && Number.isInteger(Number(teams)) && Number(teams) > 1) return (round - 1) * Number(teams) + within;
    }
    return null;
  };
  const parseDraftFeedMessage = (value, teams) => {
    const fields = String(value || "").split("|"), code = fields[0];
    if (code === "P") {
      const rows = fields.slice(1).map(field => {
        const [pickNo, detail = ""] = field.split("="), [playerId, teamId] = detail.split(",");
        return { pickNo: Number(pickNo), playerId, slot: Number(teamId) || snakeSlot(Number(pickNo), teams) };
      });
      return { type: "picks", rows };
    }
    if (code === "0") return { type: "pick", row: { pickNo: Number(fields[1]), playerId: fields[2], slot: Number(fields[3]) || snakeSlot(Number(fields[1]), teams), position: fields[4] } };
    if (code === "D") return { type: "clock", currentPickNo: Number(fields[1]) };
    if (code === "u") return { type: "undo", pickNo: Number(fields[1]) };
    if (code === "r") return { type: "reset" };
    if (code === "Y") return { type: "complete" };
    return null;
  };
  const helpers = { yahooDraftInfo, snakeSlot, positionFromText, receptionValue, settingsFromRoster, settingsFromYahooService, normalizePlayers, catalogRowsFromService, mergePlayerPool, normalizePicks, mergePickRows, appendContiguousPicks, currentPickFromTexts, parseDraftFeedMessage };
  if (globalThis.__draftChampionYahooTestMode) { globalThis.__draftChampionYahooHelpers = helpers; return; }

  const info = yahooDraftInfo(location.href);
  if (!info) return;
  const existingAdapter = globalThis.__draftChampionYahooAdapter;
  existingAdapter?.stop?.();
  if (globalThis.__draftChampionYahooAdapter === existingAdapter) globalThis.__draftChampionYahooAdapter = null;
  const adapterSession = { version: "2026-08-04i", id: crypto?.randomUUID?.() || `yahoo-${Date.now()}-${Math.random()}`, phase: "connecting", lastError: "", lastFingerprint: "", stopped: false, href: location.href, pickHistory: [], officialSettings: null, settingsRetryTimer: null, playerCatalog: new Map(), catalogReady: false, catalogRetryTimer: null, feedReady: false, feedCurrentPick: null, feedComplete: false, feedSocket: null, feedReconnectTimer: null };
  globalThis.__draftChampionYahooAdapter = adapterSession;
  const sessionIsCurrent = () => !adapterSession.stopped && globalThis.__draftChampionYahooAdapter === adapterSession;
  let stopAdapter = () => {};
  const send = (message, catchStale = true) => {
    try {
      return chrome.runtime.sendMessage(message).then(response => { if (catchStale && response?.stale) stopAdapter(); return response; }).catch(error => { if (/extension context invalidated|receiving end does not exist|message port closed/i.test(String(error?.message || error))) stopAdapter(); return null; });
    } catch { return Promise.resolve(null); }
  };
  const activation = await send({ type: "ADAPTER_ACTIVATED", platform: "yahoo", draftId: info.draftId, adapterSessionId: adapterSession.id });
  if (!activation?.ok) throw new Error(activation?.error || "Yahoo adapter could not register with Draft Goblin.");
  const textOf = element => clean(element?.innerText || element?.textContent);
  const teamCount = () => { if (Number.isInteger(adapterSession.officialSettings?.teams)) return adapterSession.officialSettings.teams; const ids = [...document.querySelectorAll(".ys-team[data-id]")].map(element => Number(element.getAttribute("data-id"))).filter(Number.isInteger); return ids.length ? Math.max(...ids) : 12; };
  const rosterDetails = () => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],[class*="team" i]')].find(element => /^YOUR TEAM\s*\(\s*\d+\s*\/\s*\d+\s*\)$/i.test(textOf(element))), roundMatch = textOf(heading).match(/\/\s*(\d+)\s*\)/);
    let list = heading?.parentElement?.querySelector("ul");
    for (let parent = heading?.parentElement; !list && parent && parent !== document.body; parent = parent.parentElement) list = parent.querySelector("ul");
    const slotLabels = /^(?:QB|RB|WR|TE|K|DEF|DST|BN|BE)$/i, flexLabel = /^(?:W|R|T)$/i;
    const labels = [...(list?.children || [])].flatMap(item => {
      const lines = String(item.innerText || item.textContent || "").split(/\n/).map(clean).filter(Boolean), first = lines[0] || "";
      if (/^(?:W\s*\|?\s*R\s*\|?\s*T)$/i.test(first) || (lines.length >= 3 && flexLabel.test(lines[0]) && flexLabel.test(lines[1]) && flexLabel.test(lines[2]))) return ["FLEX"];
      return slotLabels.test(first) ? [first.toUpperCase()] : [];
    });
    const fallback = labels.length ? labels : ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"];
    return { rounds: Number(roundMatch?.[1]) || fallback.length || 15, labels: fallback };
  };
  const playerRows = () => [...document.querySelectorAll(".ys-player[data-id]")].map(root => {
    const row = root.closest("tr"), cells = row ? [...row.children].filter(child => child.tagName === "TD").map(textOf) : [], abbreviations = [...root.querySelectorAll("abbr")], image = root.querySelector("img[title]");
    return { id: root.getAttribute("data-id"), name: clean(image?.getAttribute("title") || root.querySelector("span")?.textContent), position: positionFromText(abbreviations[0]?.getAttribute("title") || abbreviations[0]?.textContent), team: clean(abbreviations[1]?.textContent), adp: cells[4], platformProjection: cells[6], injuryStatus: root.querySelector('[title*="Injured"], [aria-label*="Injured"]') ? "injury" : "" };
  });
  const pickRows = () => {
    const rows = [];
    for (const root of document.querySelectorAll(".ys-player[data-id]")) {
      const image = root.querySelector("img[title]"), name = clean(image?.getAttribute("title") || root.querySelector("span")?.textContent); let ancestor = root.parentElement;
      for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
        const lines = String(ancestor.innerText || ancestor.textContent || "").split(/\n/).map(clean).filter(Boolean), pickNo = Number(lines[0]);
        if (!Number.isInteger(pickNo) || pickNo < 1 || !lines[1] || !lines.includes(name)) continue;
        const abbreviations = [...root.querySelectorAll("abbr")];
        rows.push({ pickNo, playerId: root.getAttribute("data-id"), slot: 0, name, position: abbreviations[0]?.textContent, team: abbreviations[1]?.textContent }); break;
      }
    }
    return rows;
  };
  const rememberVisiblePicks = teams => {
    adapterSession.pickHistory = appendContiguousPicks(adapterSession.pickHistory, pickRows(), teams);
    return adapterSession.pickHistory;
  };
  const clockPick = (teams, pageText = "") => {
    return Number.isInteger(adapterSession.feedCurrentPick) ? adapterSession.feedCurrentPick : currentPickFromTexts([pageText], teams);
  };
  const readState = (bodyText = "") => {
    const currentInfo = yahooDraftInfo(location.href); if (!currentInfo || currentInfo.draftId !== info.draftId) return null;
    const season = new Date().getFullYear(), teams = teamCount(), roster = rosterDetails();
    let settings = adapterSession.officialSettings || settingsFromRoster({ teams, rounds: roster.rounds, labels: roster.labels, scoringText: bodyText });
    if (!settings) settings = settingsFromRoster({ teams, rounds: roster.rounds, labels: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"], scoringText: bodyText });
    if (!settings) throw new Error("Yahoo roster settings are not visible yet.");
    const picks = rememberVisiblePicks(teams), visiblePlayers = normalizePlayers(playerRows(), season), players = mergePlayerPool([...adapterSession.playerCatalog.values()], visiblePlayers, picks), playerIds = new Set(players.map(player => player.id));
    for (const pick of picks) if (!playerIds.has(pick.playerId)) {
      const catalogPlayer = adapterSession.playerCatalog.get(pick.playerId), player = catalogPlayer || normalizePlayers([pick], season)[0];
      if (player) { players.push({ ...player, eligibleForRecommendation: false }); playerIds.add(player.id); }
    }
    const currentPickNo = clockPick(teams, bodyText) || picks.length + 1, expectedPicks = settings.teams * settings.rounds;
    const draftStatus = adapterSession.feedComplete || /draft\s+(?:complete|finished)/i.test(bodyText) || picks.length >= expectedPicks ? "complete" : picks.length || currentPickNo > 1 ? "drafting" : "predraft";
    return { platform: "yahoo", draftId: info.draftId, draftRunId: `yahoo:${info.draftId}`, draftStatus, projectionSeason: season, userSlot: info.userSlot, currentPickNo, settings, picks, players, updatedAt: Date.now(), projectionSource: "Yahoo visible draft projections" };
  };
  const sendHeartbeat = () => send({ type: "ADAPTER_HEARTBEAT", platform: "yahoo", draftId: info.draftId, adapterSessionId: adapterSession.id, phase: adapterSession.phase, error: adapterSession.lastError });
  const publish = async () => {
    if (!sessionIsCurrent() || document.hidden) return;
    try {
      const pageText = document.body?.textContent || "";
      const teams = teamCount(); rememberVisiblePicks(teams);
      const currentPick = clockPick(teams, pageText);
      if (!adapterSession.officialSettings || adapterSession.pickHistory.length && !adapterSession.catalogReady) { adapterSession.phase = "syncing"; await sendHeartbeat(); return; }
      if (Number.isInteger(currentPick) && currentPick > adapterSession.pickHistory.length + 1) { adapterSession.phase = "syncing"; await sendHeartbeat(); return; }
      const state = readState(pageText); if (!state) return;
      const fingerprint = JSON.stringify([state.currentPickNo, state.picks.map(pick => [pick.pickNo, pick.playerId, pick.slot]), state.players.map(player => [player.id, player.platformProjection, player.adp])]);
      adapterSession.phase = "live"; adapterSession.lastError = "";
      if (fingerprint === adapterSession.lastFingerprint) { await sendHeartbeat(); return; }
      adapterSession.lastFingerprint = fingerprint; await send({ type: "DRAFT_STATE", platform: "yahoo", draftId: info.draftId, adapterSessionId: adapterSession.id, state }, false);
    } catch (error) { adapterSession.phase = "error"; adapterSession.lastError = error?.message || "Yahoo draft state could not be read."; await send({ type: "DRAFT_ERROR", platform: "yahoo", draftId: info.draftId, adapterSessionId: adapterSession.id, error: adapterSession.lastError }); }
  };
  let pollTimer = null, healthTimer = null, navigationTimer = null, publishInFlight = false, publishQueued = false;
  stopAdapter = () => { if (adapterSession.stopped) return; adapterSession.stopped = true; clearInterval(pollTimer); clearInterval(healthTimer); clearInterval(navigationTimer); clearTimeout(adapterSession.settingsRetryTimer); clearTimeout(adapterSession.catalogRetryTimer); clearTimeout(adapterSession.feedReconnectTimer); try { adapterSession.feedSocket?.close?.(); } catch {} if (globalThis.__draftChampionYahooAdapter === adapterSession) globalThis.__draftChampionYahooAdapter = null; };
  adapterSession.stop = stopAdapter;
  const requestPublish = async () => {
    if (publishInFlight) { publishQueued = true; return; }
    publishInFlight = true;
    try { do { publishQueued = false; await publish(); } while (publishQueued && sessionIsCurrent()); }
    finally { publishInFlight = false; }
  };
  const loadPlayerCatalog = async () => {
    try {
      const response = await fetch(`https://pub-api.fantasysports.yahoo.com/fantasy/v3/players/nfl/${encodeURIComponent(info.draftId)}?projected=1&average=1&images=0&format=rawjson`, { credentials: "include" });
      if (!response.ok) throw new Error(`Yahoo player catalog status ${response.status}`);
      const payload = await response.json(), season = new Date().getFullYear();
      adapterSession.playerCatalog = new Map(normalizePlayers(catalogRowsFromService(payload?.service), season).map(player => [player.id, player]));
      adapterSession.catalogReady = adapterSession.playerCatalog.size > 0;
      if (!adapterSession.catalogReady) throw new Error("Yahoo player catalog was empty.");
      requestPublish();
    } catch (error) {
      if (!sessionIsCurrent()) return;
      adapterSession.lastError = error?.message || "Yahoo player catalog could not load.";
      adapterSession.catalogRetryTimer = setTimeout(loadPlayerCatalog, 3000);
    }
  };
  const loadOfficialSettings = async () => {
    try {
      const response = await fetch(`https://pub-api.fantasysports.yahoo.com/fantasy/v3/settings/nfl/${encodeURIComponent(info.draftId)}?format=rawjson`, { credentials: "include" });
      if (!response.ok) throw new Error(`Yahoo league settings status ${response.status}`);
      adapterSession.officialSettings = settingsFromYahooService((await response.json())?.service);
      if (!adapterSession.officialSettings) throw new Error("Yahoo league settings were incomplete.");
      requestPublish();
    } catch (error) {
      if (!sessionIsCurrent()) return;
      adapterSession.lastError = error?.message || "Yahoo league settings could not load.";
      adapterSession.settingsRetryTimer = setTimeout(loadOfficialSettings, 3000);
    }
  };
  const applyFeedMessage = value => {
    const teams = teamCount(), message = parseDraftFeedMessage(value, teams); if (!message) return;
    if (message.type === "picks") {
      const normalized = normalizePicks(message.rows, teams);
      if (!normalized.error) { adapterSession.pickHistory = normalized.picks; adapterSession.feedReady = true; }
    } else if (message.type === "pick") {
      adapterSession.pickHistory = appendContiguousPicks(adapterSession.pickHistory, [message.row], teams);
      adapterSession.feedReady = true;
    } else if (message.type === "clock" && Number.isInteger(message.currentPickNo)) adapterSession.feedCurrentPick = message.currentPickNo;
    else if (message.type === "undo" && Number.isInteger(message.pickNo)) adapterSession.pickHistory = adapterSession.pickHistory.filter(pick => pick.pickNo < message.pickNo);
    else if (message.type === "reset") { adapterSession.pickHistory = []; adapterSession.feedCurrentPick = 1; adapterSession.feedComplete = false; }
    else if (message.type === "complete") adapterSession.feedComplete = true;
    requestPublish();
  };
  const connectDraftFeed = async () => {
    if (!sessionIsCurrent()) return;
    try {
      const response = await fetch(`https://pub-api.fantasysports.yahoo.com/fantasy/v3/draftstatus/nfl/${encodeURIComponent(info.draftId)}?format=rawjson`, { credentials: "include" });
      if (!response.ok) throw new Error(`Yahoo draft feed status ${response.status}`);
      const status = (await response.json())?.service || {}, host = clean(status.draft_server), port = Number(status.draft_port) || 443;
      if (!host) throw new Error("Yahoo draft feed server is unavailable.");
      const socket = new WebSocket(`wss://${host}:${port}/`); adapterSession.feedSocket = socket;
      socket.addEventListener("open", () => {
        if (!sessionIsCurrent() || adapterSession.feedSocket !== socket) return;
        const auth = new URL(location.href).searchParams.get("auth") || "";
        socket.send(["9", info.draftId, info.userSlot, encodeURIComponent("Draft Goblin"), auth].join("|"));
      });
      socket.addEventListener("message", event => { if (sessionIsCurrent() && adapterSession.feedSocket === socket) applyFeedMessage(event.data); });
      socket.addEventListener("close", () => {
        if (!sessionIsCurrent() || adapterSession.feedSocket !== socket) return;
        adapterSession.feedSocket = null;
        adapterSession.feedReconnectTimer = setTimeout(connectDraftFeed, 2000);
      });
      socket.addEventListener("error", () => { try { socket.close(); } catch {} });
    } catch (error) {
      if (!sessionIsCurrent()) return;
      adapterSession.lastError = error?.message || "Yahoo draft feed could not connect.";
      adapterSession.feedReconnectTimer = setTimeout(connectDraftFeed, 2000);
    }
  };
  healthTimer = setInterval(sendHeartbeat, 2000); pollTimer = setInterval(requestPublish, 2000);
  navigationTimer = setInterval(() => { if (location.href !== adapterSession.href) { adapterSession.href = location.href; const current = yahooDraftInfo(location.href); if (!current || current.draftId !== info.draftId) { stopAdapter(); send({ type: "DRAFT_NAVIGATED", adapterSessionId: adapterSession.id }); } } }, 1000);
  document.addEventListener?.("visibilitychange", () => { if (!document.hidden) requestPublish(); });
  loadOfficialSettings();
  loadPlayerCatalog();
  connectDraftFeed();
  await requestPublish();
})().catch(error => { try { chrome.runtime.sendMessage({ type: "ADAPTER_BOOT_ERROR", platform: "yahoo", draftId: new URL(location.href).pathname.match(/\/draftclient\/f1\/(\d+)/i)?.[1] || "", error: error?.message || "Yahoo adapter failed during startup." }).catch?.(() => {}); } catch {} });
