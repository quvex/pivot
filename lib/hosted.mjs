// Hosted mode: one server, many visitors (PIVOT_HOSTED=1).
//
// The outside sources are pulled once a day for everyone (fetchRaw). Each visitor's settings (their
// ESPN league, team, scoring, manual roster and untouchables) live in their own browser and come
// with each request. Their league is fetched from ESPN when they use the app (kept for half an
// hour) and their dataset is built from the shared pull with their league's scoring and size
// (build, no network). Builds are cached, so leagues on the same scoring share work.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_SCORING, currentSeason, loadLatest } from './store.mjs';
import { fetchRaw, build } from './refresh.mjs';
import { fetchEspnLeague, fetchEspnTrades } from './sources.mjs';

const RAW_FILE = path.join(DATA_DIR, 'raw.json');
const LEAGUE_TTL = 30 * 60 * 1000;
const MAX_BUILDS = 16;
const MAX_LEAGUES = 300;

// ---------- visitors ----------
// A visitor's settings live in their own browser (localStorage) and come with each request in the
// X-Pivot-Visitor header, base64url JSON. The server keeps nothing per visitor, so it runs on hosts
// whose disk is wiped on restart, and nobody's ESPN cookies sit on the server.
const VISITOR_DEFAULTS = {
  season: currentSeason(), leagueId: '', teamId: null, espnS2: '', swid: '',
  manualRoster: [], untouchables: [], scoring: DEFAULT_SCORING, scoringSource: 'default',
  aiProvider: 'anthropic', refreshHour: 6,
};
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : null);
const ids = (v, max) => [...new Set(v.map(Number).filter(Number.isFinite))].slice(0, max);
const leagueIdOf = (v) => { const m = String(v ?? '').match(/leagueId=(\d+)/) || String(v ?? '').match(/^\s*(\d+)\s*$/); return m ? m[1] : ''; };

// Apply a change to a visitor's settings, accepting only what a visitor may set.
export function applyVisitor(cur, body = {}, statLabels = {}) {
  const next = { ...cur };
  if ('leagueId' in body) { next.leagueId = leagueIdOf(body.leagueId); if (next.leagueId !== cur.leagueId) next.teamId = null; }
  if ('teamId' in body) next.teamId = body.teamId == null || body.teamId === '' ? null : num(body.teamId, 0, 1e6);
  for (const k of ['espnS2', 'swid']) if (typeof body[k] === 'string' && body[k].trim()) next[k] = body[k].trim().slice(0, 600);
  for (const k of Array.isArray(body.clear) ? body.clear : []) if (['espnS2', 'swid'].includes(k)) next[k] = '';
  if (Array.isArray(body.manualRoster)) next.manualRoster = ids(body.manualRoster, 30);
  if (Array.isArray(body.untouchables)) next.untouchables = ids(body.untouchables, 60);
  if (body.scoring && typeof body.scoring === 'object') {
    const scoring = {};
    for (const [k, v] of Object.entries(body.scoring)) if (statLabels[k] && Number.isFinite(+v) && +v !== 0) scoring[k] = num(v, -100, 100);
    next.scoring = scoring; next.scoringSource = 'custom';
  }
  if (body.resetScoring) { next.scoring = DEFAULT_SCORING; next.scoringSource = 'default'; }
  return next;
}

// The visitor's settings from their request, checked as if they had just been set.
export function visitorFrom(req, statLabels) {
  let sent = {};
  try { sent = JSON.parse(Buffer.from(String(req.headers['x-pivot-visitor'] || ''), 'base64url').toString('utf8') || '{}'); } catch { sent = {}; }
  if (!sent || typeof sent !== 'object') sent = {};
  return applyVisitor(VISITOR_DEFAULTS, { ...sent, scoring: sent.scoringSource === 'custom' ? sent.scoring : undefined }, statLabels);
}
// What the browser keeps: the settings a visitor chose, nothing derived.
export const keepable = ({ leagueId, teamId, espnS2, swid, manualRoster, untouchables, scoring, scoringSource }) =>
  ({ leagueId, teamId, espnS2, swid, manualRoster, untouchables, ...(scoringSource === 'custom' ? { scoring, scoringSource } : {}) });

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- the shared daily pull ----------
export const shared = { raw: null, data: null, job: { running: false, error: null, startedAt: null } };
const serverSettings = () => ({ ...VISITOR_DEFAULTS, aiModel: process.env.PIVOT_AI_MODEL || 'claude-opus-5-5', anthropicKey: '' });

export function loadShared() {
  shared.data = loadLatest();
  try { shared.raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')); } catch { shared.raw = null; }
}
export async function refreshShared({ log = console.log } = {}) {
  if (shared.job.running) return;
  shared.job = { running: true, error: null, startedAt: Date.now() };
  try {
    const settings = serverSettings();
    const raw = await fetchRaw(settings, { log, withLeague: false });
    const data = await build(raw, settings, { log, persist: true });
    fs.writeFileSync(`${RAW_FILE}.tmp`, JSON.stringify(raw));
    fs.renameSync(`${RAW_FILE}.tmp`, RAW_FILE);
    shared.raw = raw; shared.data = data;
    builds.clear();
    shared.job = { running: false, error: null, startedAt: null };
  } catch (e) {
    console.error('Shared refresh failed:', e.message);
    shared.job = { running: false, error: e.message, startedAt: null };
  }
}

// ---------- each visitor's league ----------
const leagues = new Map(); // key -> { at, promise }
const leagueKey = (s) => `${s.season}:${s.leagueId}:${s.espnS2 ? hash(`${s.espnS2}|${s.swid}`).slice(0, 12) : ''}`;
export function leagueFor(s, { fresh = false } = {}) {
  const k = leagueKey(s), hit = leagues.get(k);
  // a failed lookup (private, wrong id, ESPN down) is retried after two minutes, not every request
  if (hit && !fresh && Date.now() - hit.at < (hit.failed ? 2 * 60 * 1000 : LEAGUE_TTL)) return hit.promise;
  const at = Date.now();
  const promise = Promise.all([fetchEspnLeague(s), fetchEspnTrades(s).catch(() => [])]).then(([league, trades]) => ({ league, trades, at }));
  const entry = { at, promise, failed: false };
  leagues.set(k, entry);
  promise.catch(() => { entry.failed = true; });
  if (leagues.size > MAX_LEAGUES) leagues.delete(leagues.keys().next().value);
  return promise;
}

// built datasets, least recently used first out
const builds = new Map();
function cachedBuild(k, make) {
  if (builds.has(k)) { const v = builds.get(k); builds.delete(k); builds.set(k, v); return v; }
  const v = make();
  builds.set(k, v);
  v.catch(() => builds.delete(k));
  while (builds.size > MAX_BUILDS) builds.delete(builds.keys().next().value);
  return v;
}

const withStatus = (data, extra) => (extra.length ? { ...data, meta: { ...data.meta, status: [...data.meta.status, ...extra] } } : data);

// The dataset and effective settings for one visitor.
export async function dataFor(visitor) {
  const settings = { ...visitor };
  if (!shared.data) return { data: null, settings };
  let league = null, trades = [], at = 0;
  const extra = [];
  if (settings.leagueId) {
    try {
      ({ league, trades, at } = await leagueFor(settings));
      extra.push({ key: 'league', label: 'ESPN league', ok: true, detail: `${league.name}: ${league.teams.length} teams` });
    } catch (e) {
      extra.push({ key: 'league', label: 'ESPN league', ok: false, detail: e.message });
    }
  }
  if (settings.scoringSource !== 'custom') {
    const fromLeague = league && Object.keys(league.scoring || {}).length;
    settings.scoring = fromLeague ? league.scoring : DEFAULT_SCORING;
    settings.scoringSource = fromLeague ? 'league' : 'default';
  }
  // no league and the default scoring: that is exactly the shared dataset
  if (!league && settings.scoringSource === 'default') return { data: withStatus(shared.data, extra), settings };
  if (!shared.raw) return { data: withStatus(shared.data, extra), settings: { ...settings, scoring: shared.data.meta.scoring, scoringSource: 'default' } };
  const k = [shared.data.meta.refreshedAt, league ? `${leagueKey(settings)}@${at}` : '-', JSON.stringify(settings.scoring)].join('|');
  const data = await cachedBuild(k, () => build(shared.raw, settings, {
    log: () => {}, league, leagueTrades: trades, live: shared.data.meta.live, ai: shared.data.ai,
  }));
  return { data: withStatus(data, extra), settings };
}

// ---------- a simple per-address rate limit ----------
const hits = new Map();
export function allowed(ip, bucket, max, windowMs = 60000) {
  const k = `${bucket}:${ip}`, now = Date.now();
  let h = hits.get(k);
  if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(k, h); }
  h.n += 1;
  if (hits.size > 20000) for (const [kk, v] of hits) if (now - v.start > windowMs) hits.delete(kk);
  return h.n <= max;
}
