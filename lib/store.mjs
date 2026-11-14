// Local storage: settings, latest dataset, daily history snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.PIVOT_DATA_DIR ? path.resolve(process.env.PIVOT_DATA_DIR) : path.join(ROOT, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');

// ESPN stat ids -> label. Only the ones that can carry points in a points league.
export const STAT_LABELS = {
  0: 'PTS', 1: 'BLK', 2: 'STL', 3: 'AST', 4: 'OREB', 5: 'DREB', 6: 'REB', 9: 'PF', 10: 'TF',
  11: 'TO', 13: 'FGM', 14: 'FGA', 15: 'FTM', 16: 'FTA', 17: '3PM', 18: '3PA',
  23: 'FGMI', 24: 'FTMI', 25: '3PMI', 37: 'DD', 38: 'TD', 39: 'QD', 40: 'MIN', 41: 'GS', 43: 'TW',
};

// ESPN's default points-league scoring.
export const DEFAULT_SCORING = { 0: 1, 17: 1, 13: 2, 14: -1, 15: 1, 16: -1, 6: 1, 3: 2, 2: 4, 1: 4, 11: -2 };

export function currentSeason(now = new Date()) {
  // ESPN names a season by the year it ends in. Seasons start in October.
  return now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
}

const DEFAULT_SETTINGS = {
  season: currentSeason(),
  leagueId: '',
  teamId: null,
  espnS2: '',
  swid: '',
  manualRoster: [], // ESPN player ids, used when no league is synced
  scoring: DEFAULT_SCORING,
  scoringSource: 'default', // 'default' | 'league' | 'custom'
  anthropicKey: '',
  aiModel: 'claude-opus-5-5',
  aiProvider: 'anthropic', // 'anthropic' | 'compatible' (any OpenAI-compatible chat API)
  altBaseUrl: '',
  altKey: '',
  altModel: '',
  refreshHour: 6, // local hour after which the daily refresh runs
  meshyKey: '', // player faces on the court, made on this computer only (lib/heads.mjs)
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(SETTINGS_FILE, next, 0o600); // holds cookies / API key: owner-only
  return next;
}

// Is a written briefing configured? A local endpoint (Ollama and the like) needs no key.
export const isLocalUrl = (u) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u || '');
export function aiReady(s) {
  if (s.aiProvider === 'compatible') return Boolean(s.altBaseUrl && s.altModel && (s.altKey || isLocalUrl(s.altBaseUrl)));
  return Boolean(s.anthropicKey || process.env.ANTHROPIC_API_KEY);
}

// What the browser is allowed to see: never echo secrets back.
export function publicSettings(s = loadSettings()) {
  const { espnS2, swid, anthropicKey, altKey, meshyKey, ...rest } = s;
  return {
    ...rest,
    hasEspnCookies: Boolean(espnS2 && swid),
    hasAnthropicKey: Boolean(anthropicKey || process.env.ANTHROPIC_API_KEY),
    hasAltKey: Boolean(altKey),
    hasMeshyKey: Boolean(meshyKey || process.env.MESHY_API_KEY),
    aiReady: aiReady(s),
  };
}

export const loadLatest = () => readJson(LATEST_FILE, null);
export const saveLatest = (data) => writeJson(LATEST_FILE, data);

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Daily projections, kept for the whole season so they can be scored once games are played.
const PREDICTIONS_DIR = path.join(DATA_DIR, 'predictions');
export const savePredictions = (date, snap) => writeJson(path.join(PREDICTIONS_DIR, `${date}.json`), { date, ...snap });
export function loadPredictions() {
  let files = [];
  try { files = fs.readdirSync(PREDICTIONS_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.map((f) => readJson(path.join(PREDICTIONS_DIR, f), null)).filter(Boolean);
}

export function saveSnapshot(day, snapshot) {
  writeJson(path.join(HISTORY_DIR, `${day}.json`), snapshot);
  // keep 90 days
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 90))) fs.unlinkSync(path.join(HISTORY_DIR, f));
}

// Most recent snapshot at least `minDaysAgo` days before `day` (so "yesterday" survives gaps).
export function loadSnapshotBefore(day, minDaysAgo = 1) {
  let files = [];
  try { files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
  const cutoff = new Date(day + 'T12:00:00');
  cutoff.setDate(cutoff.getDate() - minDaysAgo);
  const cutKey = dayKey(cutoff);
  const pick = files.filter((f) => f.slice(0, 10) <= cutKey).pop();
  return pick ? { day: pick.slice(0, 10), players: readJson(path.join(HISTORY_DIR, pick), {}) } : null;
}
