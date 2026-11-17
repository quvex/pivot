// Hosted mode: one server, many visitors (PIVOT_HOSTED=1).
//
// The outside sources are pulled once a day for everyone (fetchRaw). Each visitor gets an
// anonymous session cookie and their own small settings file: their ESPN league, team, scoring,
// manual roster and untouchables. Their league is fetched from ESPN when they use the app (kept
// for half an hour) and their dataset is built from the shared pull with their league's scoring
// and size (build, no network). Builds are cached, so leagues on the same scoring share work.
//
// Private-league cookies are encrypted at rest with PIVOT_SECRET. The session id itself is never
// written to disk: files are named by its hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_SCORING, currentSeason, loadLatest } from './store.mjs';
import { fetchRaw, build } from './refresh.mjs';
import { fetchEspnLeague, fetchEspnTrades } from './sources.mjs';

const USERS_DIR = path.join(DATA_DIR, 'users');
const RAW_FILE = path.join(DATA_DIR, 'raw.json');
const LEAGUE_TTL = 30 * 60 * 1000;
const MAX_BUILDS = 16;
const MAX_LEAGUES = 300;

// ---------- the encryption key ----------
function secretKey() {
  let secret = process.env.PIVOT_SECRET;
  if (!secret) {
    // no secret configured: make one and keep it next to the data, so restarts can still decrypt
    const file = path.join(DATA_DIR, 'secret');
    try { secret = fs.readFileSync(file, 'utf8').trim(); } catch {
      secret = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  return crypto.createHash('sha256').update(secret).digest();
}
let KEY = null;
const key = () => (KEY ||= secretKey());
export function seal(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
export function unseal(box) {
  if (!box) return '';
  try {
    const [iv, tag, ct] = box.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; } // a changed secret: the visitor re-enters their cookies
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- sessions ----------
const COOKIE = 'pv';
export function sessionId(req, res) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{32,64})`).exec(req.headers.cookie || '');
  if (m) return m[1];
  const sid = crypto.randomBytes(24).toString('base64url');
  const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${https ? '; Secure' : ''}`);
  return sid;
}

// What a visitor can set. Everything else (AI keys, the update hour) belongs to the server.
const VISITOR_DEFAULTS = {
  season: currentSeason(), leagueId: '', teamId: null, espnS2: '', swid: '',
  manualRoster: [], untouchables: [], scoring: DEFAULT_SCORING, scoringSource: 'default',
  aiProvider: 'anthropic', refreshHour: 6,
};
const userFile = (sid) => path.join(USERS_DIR, `${hash(sid).slice(0, 40)}.json`);
export function visitorSettings(sid) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(userFile(sid), 'utf8')); } catch { /* new visitor */ }
  return { ...VISITOR_DEFAULTS, ...saved, season: VISITOR_DEFAULTS.season, espnS2: unseal(saved.espnS2), swid: unseal(saved.swid) };
}
export function saveVisitor(sid, patch) {
  const next = { ...visitorSettings(sid), ...patch };
  const stored = { ...next, espnS2: seal(next.espnS2), swid: seal(next.swid), seen: Date.now() };
  delete stored.season; delete stored.aiProvider; delete stored.refreshHour;
  fs.mkdirSync(USERS_DIR, { recursive: true });
  const file = userFile(sid), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

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
