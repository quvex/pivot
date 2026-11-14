// Local web server: serves the UI and a small JSON API. Listens on localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSettings, saveSettings, publicSettings, loadLatest, dayKey, DEFAULT_SCORING, STAT_LABELS } from './lib/store.mjs';
import { refresh } from './lib/refresh.mjs';
import { ownership, outcomesFor } from './lib/news.mjs';
import { recommendTrades, recommendWaivers, weekPlan, capOutlook } from './lib/model.mjs';
import { tradeContext, evaluateTrade, mockOffers } from './lib/trade.mjs';

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

let data = loadLatest();
let job = { running: false, error: null, startedAt: null };

function startRefresh() {
  if (job.running) return;
  job = { running: true, error: null, startedAt: Date.now() };
  refresh()
    .then((d) => { data = d; job = { running: false, error: null, startedAt: null }; })
    .catch((e) => { console.error('Refresh failed:', e.message); job = { running: false, error: e.message, startedAt: null }; });
}

// Daily update: once per calendar day after the configured hour, checked every 20 minutes.
function maybeDailyRefresh() {
  const now = new Date();
  const { refreshHour } = loadSettings();
  const stale = !data || data.meta.day !== dayKey(now);
  if (stale && (!data || now.getHours() >= refreshHour)) startRefresh();
}

const SLOT_LABELS = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL' };

// Standings outlook and my day-by-day plan. Needs a synced league.
function buildWeek(own) {
  const lg = data.league;
  if (!lg?.format) return null;
  const f = lg.format;
  const now = Date.now();
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const capped = f.capTotal > 0;
  const frac = Math.min(1, (data.meta.leagueGp || 0) / 82); // share of the NBA season played
  const repl = data.meta.repl;
  let mine = null;
  const teams = lg.teams.map((t) => {
    const roster = t.roster.map((id) => byId.get(id)).filter(Boolean);
    const plan = weekPlan(roster, data.schedule || {}, f.slotCounts, now);
    const cap = capped ? capOutlook(roster, t.points, t.gamesUsed, f.capTotal, repl) : null;
    const row = {
      id: t.id, name: t.name, mine: own.myTeam?.id === t.id, points: Math.round(t.points), gamesUsed: t.gamesUsed,
      perGame: t.gamesUsed ? Math.round((t.points / t.gamesUsed) * 10) / 10 : null,
      pace: capped ? Math.round(t.gamesUsed - f.capTotal * frac) : null,
      week: plan.totals, projected: cap?.projected ?? null, capLine: cap?.capLine ?? null,
    };
    if (row.mine) mine = { t, roster, plan, cap, row };
    return row;
  }).sort((a, b) => b.points - a.points);
  teams.forEach((t, i) => { t.rank = i + 1; });
  const out = { capped, capTotal: f.capTotal, scoringType: f.scoringType, seasonPct: Math.round(frac * 100), teams, my: null };
  if (!mine) return out;

  const { t, roster, plan, cap, row } = mine;
  const advice = [];
  if (capped) {
    const left = f.capTotal - t.gamesUsed;
    if (row.pace >= 5) advice.push(`You have used ${t.gamesUsed} of ${f.capTotal} games with ${out.seasonPct}% of the season played: ${row.pace} ahead of an even pace. You will run out before the season ends unless you skip about ${row.pace} of your weakest starts, so save games for players above your cap line.`);
    else if (row.pace <= -5) advice.push(`You have used ${t.gamesUsed} of ${f.capTotal} games: ${-row.pace} behind an even pace. Unused games are wasted points, so start everyone who is playing and consider adding players with busy schedules.`);
    else advice.push(`Games pace is on track: ${t.gamesUsed} of ${f.capTotal} used, ${left} left.`);
    if (row.pace > -5) {
      const weak = roster.filter((p) => p.model.next < cap.capLine - 0.5 && (plan.perPlayer[p.id].exp[0] + plan.perPlayer[p.id].exp[1]) > 0)
        .sort((a, b) => a.model.next - b.model.next);
      for (const p of weak) advice.push(`Sit ${p.name} (${p.model.next} FP/G): he is below your cap line of ${cap.capLine}, so each start costs about ${(cap.capLine - p.model.next).toFixed(1)} points compared with saving the game for a better player.`);
    }
  }
  const irIds = new Set(t.ir || []);
  const irSlots = f.slotCounts[13] || 0;
  for (const p of roster) {
    if (irIds.has(p.id) && p.injuryStatus === 'ACTIVE') advice.push(`${p.name} is healthy but still in your IR slot: activate him.`);
    else if (!irIds.has(p.id) && p.avail.missed >= 3) {
      advice.push(irIds.size < irSlots ? `${p.name} is out (${p.avail.note}): move him to IR to open a roster spot.`
        : `${p.name} is out (${p.avail.note}) and your IR slot is taken, so he is using a roster spot.`);
    } else if (p.injuryStatus === 'DAY_TO_DAY') advice.push(`${p.name} is day-to-day: check his status before his next game locks.`);
  }
  out.my = {
    name: t.name, capLine: cap?.capLine ?? null, projected: cap?.projected ?? null, advice,
    days: plan.days,
    players: roster.map((p) => ({ id: p.id, inIR: irIds.has(p.id), ...plan.perPlayer[p.id] }))
      .sort((a, b) => (b.pts[0] + b.pts[1]) - (a.pts[0] + a.pts[1])),
    slots: capped ? Object.entries(f.slotLimits).map(([slot, limit]) => ({
      label: SLOT_LABELS[slot] || slot, limit, used: t.slotUsed[slot] || 0, even: Math.round(limit * frac),
    })) : [],
  };
  return out;
}

// Everything the UI needs, with league context applied.
function buildState() {
  const settings = loadSettings();
  const base = { settings: publicSettings(settings), job, statLabels: STAT_LABELS, defaultScoring: DEFAULT_SCORING };
  if (!data) return { ...base, ready: false };
  const own = ownership(data, settings);
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const players = data.players.map((p) => ({ ...p, own: own.get(p.id) }));

  const news = data.news.map((n) => {
    const { relevance, lines } = outcomesFor(n, byId, own, data.meta.repl);
    const p = byId.get(n.playerId);
    return { ...n, name: p?.name, team: p?.team, pos: p?.pos, own: own.get(n.playerId), relevance, lines, ai: data.ai?.outcomes?.[n.id] || null };
  }).sort((a, b) => b.relevance - a.relevance || b.sev - a.sev || b.time - a.time);

  const briefing = data.ai?.briefing?.length
    ? { by: 'claude', model: data.ai.model, lines: data.ai.briefing }
    : { by: 'rules', lines: news.filter((n) => n.relevance >= 2 && n.sev >= 1 && n.lines.length).slice(0, 6).map((n) => n.lines[0]) };

  const hasRoster = own.mine.size > 0;
  const owners = own.synced ? new Map([...own.map].filter(([, o]) => o.type === 'team').map(([id, o]) => [id, o.team])) : null;
  // every recommended trade goes through the same engine as the analyser, so the reasoning matches
  const ctx = tradeContext(data, own);
  const trades = hasRoster ? recommendTrades(data.players, own.mine, owners).map((t) => evaluateTrade(ctx, t.give, t.get)).filter((t) => t && t.delta > 0) : [];

  const isFree = (p) => { const o = own.get(p.id); return o.type === 'fa' || (o.type === 'unknown' && p.owned < 60); };
  const waivers = recommendWaivers(data.players, own.mine, isFree, data.meta.repl);

  return {
    ...base, ready: true, meta: data.meta, players, news, headlines: data.headlines, briefing, trades, waivers, week: buildWeek(own), hasRoster,
    league: data.league ? { id: data.league.id, name: data.league.name, teams: data.league.teams.map(({ id, name, owner, roster }) => ({ id, name, owner, size: roster.length, roster })) } : null,
    myTeam: own.myTeam ? { id: own.myTeam.id, name: own.myTeam.name } : null,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

const cleanNum = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : null);

async function updateSettings(body) {
  const cur = loadSettings();
  const patch = {};
  let needsRefresh = false;
  if ('leagueId' in body) {
    // accept a pasted ESPN league URL as well as a bare id
    const m = String(body.leagueId).match(/leagueId=(\d+)/) || String(body.leagueId).match(/^\s*(\d+)\s*$/);
    patch.leagueId = m ? m[1] : '';
    if (patch.leagueId !== cur.leagueId) { needsRefresh = true; patch.teamId = null; }
  }
  if ('season' in body) { const s = cleanNum(body.season, 2020, 2100); if (s && s !== cur.season) { patch.season = s; needsRefresh = true; } }
  if ('teamId' in body) patch.teamId = body.teamId == null || body.teamId === '' ? null : Number(body.teamId);
  if (['anthropic', 'compatible'].includes(body.aiProvider) && body.aiProvider !== cur.aiProvider) { patch.aiProvider = body.aiProvider; needsRefresh = true; }
  if (typeof body.altBaseUrl === 'string' && body.altBaseUrl.trim() !== cur.altBaseUrl) { patch.altBaseUrl = body.altBaseUrl.trim().slice(0, 300); needsRefresh = true; }
  if (typeof body.altModel === 'string' && body.altModel.trim() !== cur.altModel) { patch.altModel = body.altModel.trim().slice(0, 120); needsRefresh = true; }
  for (const key of ['espnS2', 'swid', 'anthropicKey', 'altKey']) {
    if (typeof body[key] === 'string' && body[key].trim()) { patch[key] = body[key].trim(); needsRefresh = true; }
  }
  for (const key of body.clear || []) if (['espnS2', 'swid', 'anthropicKey', 'altKey'].includes(key)) patch[key] = '';
  if (typeof body.aiModel === 'string' && /^claude-[a-z0-9-]+$/.test(body.aiModel)) patch.aiModel = body.aiModel;
  if (Array.isArray(body.manualRoster)) patch.manualRoster = [...new Set(body.manualRoster.map(Number).filter(Number.isFinite))].slice(0, 30);
  if ('refreshHour' in body) { const h = cleanNum(body.refreshHour, 0, 23); if (h != null) patch.refreshHour = Math.round(h); }
  if (body.scoring && typeof body.scoring === 'object') {
    const scoring = {};
    for (const [k, v] of Object.entries(body.scoring)) if (STAT_LABELS[k] && Number.isFinite(+v) && +v !== 0) scoring[k] = +v;
    patch.scoring = scoring; patch.scoringSource = 'custom'; needsRefresh = true;
  }
  if (body.resetScoring) { patch.scoring = DEFAULT_SCORING; patch.scoringSource = 'default'; needsRefresh = true; }
  saveSettings(patch);
  if (needsRefresh) startRefresh();
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    // Only answer requests addressed to this machine (blocks DNS-rebinding from other sites).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'Forbidden' });
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, buildState());
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { job, refreshedAt: data?.meta.refreshedAt || null });
      if (req.method === 'GET' && url.pathname === '/api/trade/offers') {
        if (!data) return send(409, { error: 'No data yet' });
        const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
        return send(200, mockOffers(tradeContext(data, ownership(data, loadSettings())), { playerId: num('player'), teamId: num('team') }));
      }
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').includes('application/json')) return send(415, { error: 'Expected JSON' });
        const body = await readBody(req);
        if (url.pathname === '/api/refresh') { startRefresh(); return send(202, { job }); }
        if (url.pathname === '/api/trade/evaluate') {
          if (!data) return send(409, { error: 'No data yet' });
          const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite).slice(0, 5) : []);
          return send(200, { trade: evaluateTrade(tradeContext(data, ownership(data, loadSettings())), ids(body.give), ids(body.get)) });
        }
        if (url.pathname === '/api/settings') { await updateSettings(body); return send(200, { job, settings: publicSettings() }); }
      }
      return send(404, { error: 'Not found' });
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'Not found', 'text/plain');
    return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fantasy Hoops running at http://localhost:${PORT}`);
  maybeDailyRefresh();
  setInterval(maybeDailyRefresh, 20 * 60 * 1000);
});
