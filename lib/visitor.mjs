// A visitor of the public app: their settings, and the dataset they see. No Node-only imports, so
// it runs on the hosted server (hosted.mjs) and in the visitor's own browser (web/engine.mjs).
//
// A visitor's settings (league, team, scoring, manual roster and untouchables) live in their own
// browser. Their league is read from ESPN when they use the app (kept for half an hour) and their
// dataset is built from the day's shared pull with their league's scoring and size (build: no
// network). Builds are cached, so leagues on the same scoring share work.
import { DEFAULT_SCORING, currentSeason } from './store.mjs';

const LEAGUE_TTL = 30 * 60 * 1000;
const FAILED_TTL = 2 * 60 * 1000;

export const VISITOR_DEFAULTS = {
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

// Settings sent back by a browser, checked as if they had just been set.
export function parseVisitor(sent, statLabels) {
  if (!sent || typeof sent !== 'object') sent = {};
  return applyVisitor(VISITOR_DEFAULTS, { ...sent, scoring: sent.scoringSource === 'custom' ? sent.scoring : undefined }, statLabels);
}
// What the browser keeps: the settings a visitor chose, nothing derived.
export const keepable = ({ leagueId, teamId, espnS2, swid, manualRoster, untouchables, scoring, scoringSource }) =>
  ({ leagueId, teamId, espnS2, swid, manualRoster, untouchables, ...(scoringSource === 'custom' ? { scoring, scoringSource } : {}) });

// a short, stable tag for a string (a cache key, not a secret)
const tag = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
const withStatus = (data, extra) => (extra.length ? { ...data, meta: { ...data.meta, status: [...data.meta.status, ...extra] } } : data);

// shared: { raw, data } (the day's pull and its default dataset), read when needed.
export function createViewer({ shared, build, fetchEspnLeague, fetchEspnTrades, maxBuilds = 16, maxLeagues = 300 }) {
  const leagues = new Map(); // key -> { at, promise, failed }
  const builds = new Map(); // least recently used first
  const leagueKey = (s) => `${s.season}:${s.leagueId}:${s.espnS2 ? tag(`${s.espnS2}|${s.swid}`) : ''}`;

  function leagueFor(s, { fresh = false } = {}) {
    const k = leagueKey(s), hit = leagues.get(k);
    // a failed lookup (private, wrong id, ESPN down) is retried after two minutes, not every request
    if (hit && !fresh && Date.now() - hit.at < (hit.failed ? FAILED_TTL : LEAGUE_TTL)) return hit.promise;
    const at = Date.now();
    const promise = Promise.all([fetchEspnLeague(s), fetchEspnTrades(s).catch(() => [])]).then(([league, trades]) => ({ league, trades, at }));
    const entry = { at, promise, failed: false };
    leagues.set(k, entry);
    promise.catch(() => { entry.failed = true; });
    if (leagues.size > maxLeagues) leagues.delete(leagues.keys().next().value);
    return promise;
  }
  function cachedBuild(k, make) {
    if (builds.has(k)) { const v = builds.get(k); builds.delete(k); builds.set(k, v); return v; }
    const v = make();
    builds.set(k, v);
    v.catch(() => builds.delete(k));
    while (builds.size > maxBuilds) builds.delete(builds.keys().next().value);
    return v;
  }

  // The dataset and effective settings for one visitor.
  async function dataFor(visitor) {
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

  return { dataFor, leagueFor, clear: () => builds.clear() };
}
