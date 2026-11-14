// Player faces, made and kept on this computer only.
//
// scripts/faces.py runs TripoSR (open source, MIT) on each player's ESPN headshot and saves a 3D
// bust to data/heads/<espn id>.glb. data/ is never committed, and only the local server hands the
// busts to the court, which fits them onto the players' bodies. The public demo has no server, so it
// never shows a face: real players' likenesses stay on the machine that made them.
// The generator is set up once with `npm run faces:setup` (scripts/faces-setup.sh).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR } from './store.mjs';

export const HEADS_DIR = path.join(DATA_DIR, 'heads');
const PYTHON = path.join(ROOT, '.faces', 'venv', 'bin', 'python');
const SCRIPT = path.join(ROOT, 'scripts', 'faces.py');

export const facesInstalled = () => fs.existsSync(PYTHON) && fs.existsSync(path.join(ROOT, '.faces', 'TripoSR'));
export const headPath = (id, dir = HEADS_DIR) => path.join(dir, `${Number(id)}.glb`);
export const hasHead = (id, dir = HEADS_DIR) => Number.isFinite(Number(id)) && fs.existsSync(headPath(id, dir));

const jobs = new Map(); // espn id -> { state: 'queued' | 'running' | 'failed', error? }
let queue = [];
let busy = false;

export function headStatus(dir = HEADS_DIR) {
  let ready = [];
  try { ready = fs.readdirSync(dir).map((f) => /^(\d+)\.glb$/.exec(f)?.[1]).filter(Boolean).map(Number); } catch { /* none yet */ }
  const pending = [], failed = [];
  for (const [id, j] of jobs) {
    if (j.state === 'failed') failed.push({ id, error: j.error });
    else pending.push({ id, state: j.state });
  }
  return { ready, pending, failed };
}

// Run the generator over a batch: one Python process loads the model once and makes each face in
// turn, reporting a JSON line per player.
function runFaces(ids, dir, onLine) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [SCRIPT, dir, ...ids.map(String)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => {
      out += c;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) { onLine(out.slice(0, nl)); out = out.slice(nl + 1); }
    });
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', (e) => resolve({ code: -1, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
}

// Queue faces for these players, skipping any already made or on the way.
export function makeHeads(ids, { dir = HEADS_DIR, run = runFaces } = {}) {
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || hasHead(id, dir) || (jobs.has(id) && jobs.get(id).state !== 'failed')) continue;
    jobs.set(id, { state: 'queued' });
    queue.push(id);
  }
  return { started: pump(dir, run), ...headStatus(dir) };
}

function pump(dir, run) {
  if (busy || !queue.length) return Promise.resolve();
  busy = true;
  const batch = queue;
  queue = [];
  for (const id of batch) jobs.get(id).state = 'running';
  return run(batch, dir, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!jobs.has(msg.id)) return;
    if (msg.ok) jobs.delete(msg.id);
    else jobs.set(msg.id, { state: 'failed', error: msg.error || 'Could not make this face' });
  }).then(({ code, stderr }) => {
    // anything the generator never reported on failed with it
    const why = (stderr || '').trim().split('\n').pop() || `The face generator stopped (exit ${code})`;
    for (const id of batch) if (jobs.get(id)?.state === 'running') jobs.set(id, { state: 'failed', error: why });
  }).finally(() => { busy = false; return pump(dir, run); });
}

export function resetHeadJobs() { jobs.clear(); queue = []; busy = false; }
