// Hosted mode: one server, many visitors (PIVOT_HOSTED=1).
//
// The outside sources are pulled once a day for everyone (fetchRaw). Each visitor's settings live
// in their own browser and come with each request in the X-Pivot-Visitor header (base64url JSON);
// the server keeps nothing per visitor. What a visitor sees is built by visitor.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadLatest } from './store.mjs';
import { fetchRaw, build } from './refresh.mjs';
import { fetchEspnLeague, fetchEspnTrades } from './sources.mjs';
import { VISITOR_DEFAULTS, applyVisitor, parseVisitor, keepable, createViewer } from './visitor.mjs';

export { applyVisitor, keepable };
const RAW_FILE = path.join(DATA_DIR, 'raw.json');

// The visitor's settings from their request, checked as if they had just been set.
export function visitorFrom(req, statLabels) {
  let sent = {};
  try { sent = JSON.parse(Buffer.from(String(req.headers['x-pivot-visitor'] || ''), 'base64url').toString('utf8') || '{}'); } catch { sent = {}; }
  return parseVisitor(sent, statLabels);
}

// ---------- the shared daily pull ----------
export const shared = { raw: null, data: null, job: { running: false, error: null, startedAt: null } };
const viewer = createViewer({ shared, build, fetchEspnLeague, fetchEspnTrades });
export const { dataFor, leagueFor } = viewer;
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
    viewer.clear();
    shared.job = { running: false, error: null, startedAt: null };
  } catch (e) {
    console.error('Shared refresh failed:', e.message);
    shared.job = { running: false, error: e.message, startedAt: null };
  }
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
