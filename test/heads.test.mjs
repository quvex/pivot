import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHeads, headStatus, hasHead, resetHeadJobs } from '../lib/heads.mjs';

beforeEach(() => resetHeadJobs());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heads-'));

test('makeHeads runs one batch, records each face, and reports failures by player', async () => {
  const dir = tmp();
  const batches = [];
  const run = async (ids, out, onLine) => {
    batches.push(ids);
    await null; // the real generator is a separate process: it reports later
    fs.writeFileSync(path.join(out, '1.glb'), 'glTF');
    onLine(JSON.stringify({ id: 1, ok: true }));
    onLine('some log line that is not JSON');
    onLine(JSON.stringify({ id: 2, ok: false, error: 'No face found' }));
    return { code: 0, stderr: '' };
  };
  const first = makeHeads([1, 2], { dir, run });
  assert.deepEqual(first.pending.map((j) => j.id), [1, 2]);
  await first.started;
  assert.deepEqual(batches, [[1, 2]]);
  assert.ok(hasHead(1, dir));
  const st = headStatus(dir);
  assert.deepEqual(st.ready, [1]);
  assert.deepEqual(st.pending, []);
  assert.deepEqual(st.failed, [{ id: 2, error: 'No face found' }]);
});

test('players the generator never reports on fail with its last error line', async () => {
  const dir = tmp();
  const run = async () => ({ code: 1, stderr: 'Traceback...\nRuntimeError: out of memory\n' });
  await makeHeads([5], { dir, run }).started;
  assert.deepEqual(headStatus(dir).failed, [{ id: 5, error: 'RuntimeError: out of memory' }]);
});

test('faces already made are not made again', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '9.glb'), 'glTF');
  let called = false;
  await makeHeads([9], { dir, run: async () => { called = true; return { code: 0 }; } }).started;
  assert.equal(called, false);
});
