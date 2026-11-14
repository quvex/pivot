import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHead, hasHead, headStatus, photoUrl } from '../lib/heads.mjs';

const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16)]);
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('makeHead creates a Meshy task from the ESPN photo, waits for it and saves the model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-'));
  const calls = [];
  let polls = 0;
  const fake = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST') return json({ result: 'task-1' });
    if (url.endsWith('/task-1')) return json(++polls < 2 ? { status: 'IN_PROGRESS', progress: 40 } : { status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.example/head.glb' } });
    return { ok: true, arrayBuffer: async () => glb };
  };
  const out = await makeHead(3992, 'msy_test', { fetch: fake, dir, poll: 1 });
  assert.equal(out, path.join(dir, '3992.glb'));
  assert.ok(hasHead(3992, dir));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image_url, photoUrl(3992));
  assert.equal(calls[0].init.headers.Authorization, 'Bearer msy_test');
  assert.deepEqual(headStatus(dir).ready, [3992]);
});

test('makeHead reports a failed task and saves nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heads-'));
  const fake = async (url, init = {}) => (init.method === 'POST' ? json({ result: 't' }) : json({ status: 'FAILED', task_error: { message: 'No face found' } }));
  await assert.rejects(makeHead(7, 'k', { fetch: fake, dir, poll: 1 }), /No face found/);
  assert.equal(hasHead(7, dir), false);
});

test('makeHead surfaces a refused key', async () => {
  const fake = async () => json({ message: 'Invalid API key' }, false, 401);
  await assert.rejects(makeHead(7, 'bad', { fetch: fake, dir: os.tmpdir(), poll: 1 }), /Invalid API key/);
});
