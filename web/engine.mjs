// Pivot's engine in the visitor's browser: the public site (GitHub Pages) has no server.
//
// A GitHub Action pulls every outside source once a day and publishes the pull (raw.json) and the
// dataset built from it with default scoring (data.json). Here, in the browser, the visitor's league
// is read straight from ESPN (its league API accepts requests from other sites, and sends the
// visitor's own espn.com sign-in for a private league), and their dataset is built from the pull
// with their league's scoring and size. The app calls api() in place of the local server.
import { build } from '../lib/refresh.mjs';
import { buildState } from '../lib/state.mjs';
import { tradeContext, evaluateTrade, mockOffers } from '../lib/trade.mjs';
import { ownership } from '../lib/ownership.mjs';
import { fetchEspnLeague, fetchEspnTrades } from '../lib/sources.mjs';
import { STAT_LABELS, publicSettings } from '../lib/store.mjs';
import { applyVisitor, parseVisitor, keepable, createViewer } from '../lib/visitor.mjs';

const shared = { raw: null, data: null };
const viewer = createViewer({ shared, build, fetchEspnLeague, fetchEspnTrades, maxBuilds: 4, maxLeagues: 20 });
const job = { running: false, error: null, startedAt: null };

let dataReq = null, rawReq = null;
const getJson = async (file, fresh) => {
  const res = await fetch(file, { cache: fresh ? 'no-cache' : 'default' });
  if (!res.ok) throw new Error(`Could not load today's data (${res.status}). Try again in a minute.`);
  return res.json();
};
function loadData(fresh = false) {
  if (!dataReq || fresh) {
    dataReq = getJson('data.json', fresh).then((d) => {
      if (shared.data && shared.data.meta.refreshedAt !== d.meta.refreshedAt) { shared.raw = null; rawReq = null; viewer.clear(); }
      shared.data = d;
    }).catch((e) => { dataReq = null; throw e; });
  }
  return dataReq;
}
// the full pull (a few MB) is only needed to rebuild for a league or custom scoring
function loadRaw() {
  rawReq ||= getJson('raw.json').then((r) => { shared.raw = r; }).catch((e) => { rawReq = null; throw e; });
  return rawReq;
}
async function view(visitor) {
  await loadData();
  if (visitor.leagueId || visitor.scoringSource === 'custom') await loadRaw();
  return viewer.dataFor(visitor);
}

// path: the app's API path; body: the POST body (or undefined); sent: the settings this browser keeps
export async function api(path, body, sent) {
  const url = new URL(path, location.href), p = url.pathname;
  const visitor = parseVisitor(sent, STAT_LABELS);
  if (p.endsWith('/api/state')) { const v = await view(visitor); return { ...buildState(v.data, v.settings, job), hosted: true, web: true }; }
  if (p.endsWith('/api/status')) { await loadData(); return { job, refreshedAt: shared.data?.meta.refreshedAt || null }; }
  if (p.endsWith('/api/heads')) return { enabled: false };
  if (p.endsWith('/api/trade/offers')) {
    const v = await view(visitor);
    const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
    return mockOffers(tradeContext(v.data, ownership(v.data, v.settings)), { playerId: num('player'), teamId: num('team'), untouchable: v.settings.untouchables || [] });
  }
  if (p.endsWith('/api/trade/evaluate')) {
    const v = await view(visitor);
    const ids = (x) => (Array.isArray(x) ? x.map(Number).filter(Number.isFinite).slice(0, 5) : []);
    return { trade: evaluateTrade(tradeContext(v.data, ownership(v.data, v.settings)), ids(body?.give), ids(body?.get)) };
  }
  if (p.endsWith('/api/settings')) {
    const next = applyVisitor(visitor, body || {}, STAT_LABELS);
    return { job, settings: publicSettings(next), visitor: keepable(next) };
  }
  if (p.endsWith('/api/refresh')) {
    // pick up a newer daily pull, and read the league from ESPN again
    await loadData(true);
    if (visitor.leagueId) await viewer.leagueFor(visitor, { fresh: true }).catch(() => null);
    return { job };
  }
  if (p.endsWith('/api/league/preview')) {
    const m = String(body?.leagueId || '').match(/leagueId=(\d+)/) || String(body?.leagueId || '').match(/^\s*(\d+)\s*$/);
    if (!m) throw Object.assign(new Error('Paste your league link from fantasy.espn.com, or just the number after leagueId=.'), { code: 'bad_id' });
    try {
      const lg = await fetchEspnLeague({ season: visitor.season, leagueId: m[1] });
      return {
        league: {
          id: lg.id, name: lg.name, season: visitor.season,
          format: { kind: lg.format.kind, label: lg.format.label, supported: lg.format.supported },
          teams: lg.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner, isMine: t.isMine, size: t.roster.length })),
        },
      };
    } catch (e) { throw Object.assign(new Error(e.message), { code: e.code || 'unreachable' }); }
  }
  throw new Error('Not found');
}
