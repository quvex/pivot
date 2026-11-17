// Web server: serves the UI and a small JSON API.
// By default it is a single-user app on this computer: it listens on localhost only and keeps one
// settings file. With PIVOT_HOSTED=1 it serves many visitors (lib/hosted.mjs): a shared daily
// pull, an anonymous session per visitor and their own league, with rate limits.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSettings, saveSettings, publicSettings, loadLatest, dayKey, DEFAULT_SCORING, STAT_LABELS } from './lib/store.mjs';
import { refresh } from './lib/refresh.mjs';
import { ownership } from './lib/ownership.mjs';
import { tradeContext, evaluateTrade, mockOffers } from './lib/trade.mjs';
import { buildState } from './lib/state.mjs';
import { fetchEspnLeague } from './lib/sources.mjs';
import { headStatus, makeHeads, hasHead, headPath, facesInstalled } from './lib/heads.mjs';
import * as hosted from './lib/hosted.mjs';

const HOSTED = process.env.PIVOT_HOSTED === '1';

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };

let data = HOSTED ? null : loadLatest();
let job = { running: false, error: null, startedAt: null };

// A refresh asked for while one is running (say, a league saved during the first-run pull) is
// queued, so the new settings are always picked up.
let queued = false;
function startRefresh() {
  if (job.running) { queued = true; return; }
  queued = false;
  job = { running: true, error: null, startedAt: Date.now() };
  refresh()
    .then((d) => { data = d; job = { running: false, error: null, startedAt: null }; })
    .catch((e) => { console.error('Refresh failed:', e.message); job = { running: false, error: e.message, startedAt: null }; })
    .finally(() => { if (queued) startRefresh(); });
}

// Daily update: once per calendar day after the configured hour, checked every 20 minutes.
function maybeDailyRefresh() {
  const now = new Date();
  if (HOSTED) {
    const d = hosted.shared.data, hour = Number(process.env.PIVOT_REFRESH_HOUR ?? 6);
    if (!d || !hosted.shared.raw || (d.meta.day !== dayKey(now) && now.getHours() >= hour)) hosted.refreshShared();
    return;
  }
  const { refreshHour } = loadSettings();
  const stale = !data || data.meta.day !== dayKey(now);
  if (stale && (!data || now.getHours() >= refreshHour)) startRefresh();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

const cleanNum = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : null);
const cleanIds = (v, max) => [...new Set(v.map(Number).filter(Number.isFinite))].slice(0, max);
const leagueIdOf = (v) => { const m = String(v ?? '').match(/leagueId=(\d+)/) || String(v ?? '').match(/^\s*(\d+)\s*$/); return m ? m[1] : ''; };

// A hosted visitor can set their league, team, cookies, scoring, roster and untouchables.
function updateVisitor(sid, body) {
  const cur = hosted.visitorSettings(sid);
  const patch = {};
  if ('leagueId' in body) { patch.leagueId = leagueIdOf(body.leagueId); if (patch.leagueId !== cur.leagueId) patch.teamId = null; }
  if ('teamId' in body) patch.teamId = body.teamId == null || body.teamId === '' ? null : cleanNum(body.teamId, 0, 1e6);
  for (const key of ['espnS2', 'swid']) if (typeof body[key] === 'string' && body[key].trim()) patch[key] = body[key].trim().slice(0, 600);
  for (const key of body.clear || []) if (['espnS2', 'swid'].includes(key)) patch[key] = '';
  if (Array.isArray(body.manualRoster)) patch.manualRoster = cleanIds(body.manualRoster, 30);
  if (Array.isArray(body.untouchables)) patch.untouchables = cleanIds(body.untouchables, 60);
  if (body.scoring && typeof body.scoring === 'object') {
    const scoring = {};
    for (const [k, v] of Object.entries(body.scoring)) if (STAT_LABELS[k] && Number.isFinite(+v) && +v !== 0) scoring[k] = cleanNum(v, -100, 100);
    patch.scoring = scoring; patch.scoringSource = 'custom';
  }
  if (body.resetScoring) { patch.scoring = DEFAULT_SCORING; patch.scoringSource = 'default'; }
  return hosted.saveVisitor(sid, patch);
}

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
  if (Array.isArray(body.untouchables)) patch.untouchables = [...new Set(body.untouchables.map(Number).filter(Number.isFinite))].slice(0, 60);
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
  const send = (code, body, type = 'application/json', cache = 'no-store') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    if (!HOSTED) {
      // Only answer requests addressed to this machine (blocks DNS-rebinding from other sites).
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'Forbidden' });
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      // who is asking, and the data they see
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const sid = HOSTED ? hosted.sessionId(req, res) : null;
      if (HOSTED && !hosted.allowed(ip, 'api', 240)) return send(429, { error: 'Too many requests. Wait a minute and try again.' });
      const view = async () => {
        if (!HOSTED) return { data, settings: loadSettings(), job };
        const v = await hosted.dataFor(hosted.visitorSettings(sid));
        return { ...v, job: hosted.shared.job };
      };
      if (req.method === 'GET' && url.pathname === '/api/state') { const v = await view(); return send(200, { ...buildState(v.data, v.settings, v.job), hosted: HOSTED }); }
      if (req.method === 'GET' && url.pathname === '/api/heads') return send(200, HOSTED ? { enabled: false } : { enabled: facesInstalled(), ...headStatus() });
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const d = HOSTED ? hosted.shared.data : data;
        return send(200, { job: HOSTED ? hosted.shared.job : job, refreshedAt: d?.meta.refreshedAt || null });
      }
      if (req.method === 'GET' && url.pathname === '/api/trade/offers') {
        if (HOSTED && !hosted.allowed(ip, 'offers', 40)) return send(429, { error: 'Too many requests. Wait a minute and try again.' });
        const v = await view();
        if (!v.data) return send(409, { error: 'No data yet' });
        const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
        return send(200, mockOffers(tradeContext(v.data, ownership(v.data, v.settings)), { playerId: num('player'), teamId: num('team'), untouchable: v.settings.untouchables || [] }));
      }
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').includes('application/json')) return send(415, { error: 'Expected JSON' });
        const body = await readBody(req);
        if (HOSTED && url.pathname !== '/api/trade/evaluate' && !hosted.allowed(ip, 'write', 30)) return send(429, { error: 'Too many requests. Wait a minute and try again.' });
        if (url.pathname === '/api/refresh') {
          if (!HOSTED) { startRefresh(); return send(202, { job }); }
          // a visitor can re-pull their own league; the shared sources update daily
          const s = hosted.visitorSettings(sid);
          if (s.leagueId) await hosted.leagueFor(s, { fresh: true }).catch(() => null);
          return send(202, { job: hosted.shared.job });
        }
        if (url.pathname === '/api/league/preview') {
          // Look a league up before saving it, so onboarding can show its name, format and teams.
          const m = String(body.leagueId || '').match(/leagueId=(\d+)/) || String(body.leagueId || '').match(/^\s*(\d+)\s*$/);
          if (!m) return send(400, { error: 'Paste your league link from fantasy.espn.com, or just the number after leagueId=.', code: 'bad_id' });
          const cur = HOSTED ? hosted.visitorSettings(sid) : loadSettings();
          const espnS2 = typeof body.espnS2 === 'string' && body.espnS2.trim() ? body.espnS2.trim() : cur.espnS2;
          const swid = typeof body.swid === 'string' && body.swid.trim() ? body.swid.trim() : cur.swid;
          try {
            const lg = await fetchEspnLeague({ season: cur.season, leagueId: m[1], espnS2, swid });
            return send(200, {
              league: {
                id: lg.id, name: lg.name, season: cur.season,
                format: { kind: lg.format.kind, label: lg.format.label, supported: lg.format.supported },
                teams: lg.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner, isMine: t.isMine, size: t.roster.length })),
              },
            });
          } catch (e) {
            return send(e.code === 'private' ? 403 : e.code === 'not_found' ? 404 : 502, { error: e.message, code: e.code || 'unreachable' });
          }
        }
        if (url.pathname === '/api/trade/evaluate') {
          const v = await view();
          if (!v.data) return send(409, { error: 'No data yet' });
          const ids = (x) => (Array.isArray(x) ? x.map(Number).filter(Number.isFinite).slice(0, 5) : []);
          return send(200, { trade: evaluateTrade(tradeContext(v.data, ownership(v.data, v.settings)), ids(body.give), ids(body.get)) });
        }
        if (url.pathname === '/api/heads') {
          if (HOSTED) return send(403, { error: 'Faces are only made on your own computer.' });
          if (!facesInstalled()) return send(409, { error: 'Set up the face generator first: npm run faces:setup' });
          const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite).slice(0, 12) : [];
          const { started, ...status } = makeHeads(ids);
          started.catch((e) => console.error('Faces failed:', e.message));
          return send(202, { enabled: true, ...status });
        }
        if (url.pathname === '/api/settings') {
          if (HOSTED) return send(200, { job: hosted.shared.job, settings: publicSettings(updateVisitor(sid, body)) });
          await updateSettings(body); return send(200, { job, settings: publicSettings() });
        }
      }
      return send(404, { error: 'Not found' });
    }

    // a player's face, if one has been made on this computer
    const head = /^\/heads\/(\d+)\.glb$/.exec(url.pathname);
    if (head && HOSTED) return send(404, 'Not found', 'text/plain');
    if (head) return hasHead(head[1]) ? send(200, fs.readFileSync(headPath(head[1])), 'model/gltf-binary') : send(404, 'Not found', 'text/plain');

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'Not found', 'text/plain');
    return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', HOSTED && !file.endsWith('.html') ? 'public, max-age=600' : 'no-store');
  } catch (e) {
    console.error(e);
    return send(500, { error: HOSTED ? 'Something went wrong on the server.' : e.message });
  }
});

if (HOSTED) hosted.loadShared();
server.listen(PORT, HOSTED ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(HOSTED ? `Pivot (hosted) listening on port ${PORT}` : `Fantasy Hoops running at http://localhost:${PORT}`);
  maybeDailyRefresh();
  setInterval(maybeDailyRefresh, 20 * 60 * 1000);
});
