// Local web server: serves the UI and a small JSON API. Listens on localhost only.
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

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };

let data = loadLatest();
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
  const { refreshHour } = loadSettings();
  const stale = !data || data.meta.day !== dayKey(now);
  if (stale && (!data || now.getHours() >= refreshHour)) startRefresh();
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
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, buildState(data, loadSettings(), job));
      if (req.method === 'GET' && url.pathname === '/api/heads') return send(200, { enabled: facesInstalled(), ...headStatus() });
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
        if (url.pathname === '/api/league/preview') {
          // Look a league up before saving it, so onboarding can show its name, format and teams.
          const m = String(body.leagueId || '').match(/leagueId=(\d+)/) || String(body.leagueId || '').match(/^\s*(\d+)\s*$/);
          if (!m) return send(400, { error: 'Paste your league link from fantasy.espn.com, or just the number after leagueId=.', code: 'bad_id' });
          const cur = loadSettings();
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
          if (!data) return send(409, { error: 'No data yet' });
          const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite).slice(0, 5) : []);
          return send(200, { trade: evaluateTrade(tradeContext(data, ownership(data, loadSettings())), ids(body.give), ids(body.get)) });
        }
        if (url.pathname === '/api/heads') {
          if (!facesInstalled()) return send(409, { error: 'Set up the face generator first: npm run faces:setup' });
          const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite).slice(0, 12) : [];
          const { started, ...status } = makeHeads(ids);
          started.catch((e) => console.error('Faces failed:', e.message));
          return send(202, { enabled: true, ...status });
        }
        if (url.pathname === '/api/settings') { await updateSettings(body); return send(200, { job, settings: publicSettings() }); }
      }
      return send(404, { error: 'Not found' });
    }

    // a player's face, if one has been made on this computer
    const head = /^\/heads\/(\d+)\.glb$/.exec(url.pathname);
    if (head) return hasHead(head[1]) ? send(200, fs.readFileSync(headPath(head[1])), 'model/gltf-binary') : send(404, 'Not found', 'text/plain');

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
