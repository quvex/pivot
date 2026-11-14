// Player faces, made and kept on this computer only.
//
// Each player's ESPN headshot is sent to Meshy's image-to-3D API, which returns a textured 3D bust.
// The bust is saved under data/heads/<espn id>.glb (data/ is never committed), and the local server
// hands it to the court, which fits it onto that player's body. The public demo has no server, so
// it never shows a face: real players' likenesses stay on the machine that made them.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

export const HEADS_DIR = path.join(DATA_DIR, 'heads');
const API = 'https://api.meshy.ai/openapi/v1/image-to-3d';
export const photoUrl = (id) => `https://a.espncdn.com/i/headshots/nba/players/full/${id}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = new Map(); // espn id -> { state: 'queued' | 'running' | 'failed', error?, progress? }
let queue = [];
let working = 0;

export const headPath = (id, dir = HEADS_DIR) => path.join(dir, `${Number(id)}.glb`);
export const hasHead = (id, dir = HEADS_DIR) => Number.isFinite(Number(id)) && fs.existsSync(headPath(id, dir));

export function headStatus(dir = HEADS_DIR) {
  let ready = [];
  try { ready = fs.readdirSync(dir).map((f) => /^(\d+)\.glb$/.exec(f)?.[1]).filter(Boolean).map(Number); } catch { /* none yet */ }
  const pending = [], failed = [];
  for (const [id, j] of jobs) {
    if (j.state === 'failed') failed.push({ id, error: j.error });
    else pending.push({ id, state: j.state, progress: j.progress || 0 });
  }
  return { ready, pending, failed };
}

// Make one player's head: create the task, wait for it, download the model.
export async function makeHead(id, key, { fetch: f = fetch, dir = HEADS_DIR, poll = 5000, timeout = 10 * 60 * 1000, onProgress } = {}) {
  const auth = { Authorization: `Bearer ${key}` };
  const res = await f(API, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: photoUrl(id), should_texture: true, enable_pbr: false, target_polycount: 12000 }),
  });
  const made = await res.json().catch(() => ({}));
  if (!res.ok || !made.result) throw new Error(made.message || `Meshy refused the request (${res.status})`);
  const started = Date.now();
  for (;;) {
    await sleep(poll);
    const r = await f(`${API}/${made.result}`, { headers: auth });
    const task = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(task.message || `Meshy did not answer (${r.status})`);
    onProgress?.(task.progress || 0);
    if (task.status === 'SUCCEEDED') {
      const url = task.model_urls?.glb;
      if (!url) throw new Error('Meshy finished without a model');
      const glb = Buffer.from(await (await f(url)).arrayBuffer());
      if (glb.subarray(0, 4).toString() !== 'glTF') throw new Error('Meshy sent something that is not a model');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(headPath(id, dir), glb);
      return headPath(id, dir);
    }
    if (['FAILED', 'CANCELED'].includes(task.status)) throw new Error(task.task_error?.message || `Meshy ${task.status.toLowerCase()} the task`);
    if (Date.now() - started > timeout) throw new Error('Meshy took too long');
  }
}

// Queue heads for these players, two at a time, skipping any already made or on the way.
export function makeHeads(ids, key, opts = {}) {
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || hasHead(id, opts.dir) || (jobs.has(id) && jobs.get(id).state !== 'failed')) continue;
    jobs.set(id, { state: 'queued' });
    queue.push(id);
  }
  pump(key, opts);
  return headStatus(opts.dir);
}

function pump(key, opts) {
  while (working < 2 && queue.length) {
    const id = queue.shift();
    working++;
    const job = jobs.get(id);
    job.state = 'running';
    makeHead(id, key, { ...opts, onProgress: (p) => { job.progress = p; } })
      .then(() => jobs.delete(id))
      .catch((e) => { jobs.set(id, { state: 'failed', error: e.message }); })
      .finally(() => { working--; pump(key, opts); });
  }
}

export function resetHeadJobs() { jobs.clear(); queue = []; working = 0; }
