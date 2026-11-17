// Publish the faces made on this computer (data/heads/*.glb) to the repository's `faces` branch,
// which the site workflow copies into the public site. The branch is replaced each time (one
// commit), so old busts don't pile up in the history.
//   npm run faces:publish
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HEADS_DIR } from '../lib/heads.mjs';
import { ROOT } from '../lib/store.mjs';

const files = fs.existsSync(HEADS_DIR) ? fs.readdirSync(HEADS_DIR).filter((f) => /^\d+\.glb$/.test(f)) : [];
if (!files.length) { console.log('No faces in data/heads yet. Make some on the court first.'); process.exit(0); }
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-faces-'));
const git = (...args) => execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] });
git('init', '-q', '-b', 'faces');
for (const f of files) fs.copyFileSync(path.join(HEADS_DIR, f), path.join(tmp, f));
fs.writeFileSync(path.join(tmp, 'README.md'), 'Player faces for the public Pivot site, made with TripoSR from ESPN headshots. Published by `npm run faces:publish`.\n');
git('add', '.');
git('-c', 'user.name=pivot', '-c', 'user.email=pivot@users.noreply.github.com', 'commit', '-q', '-m', `${files.length} faces`);
git('push', '-q', '--force', remote, 'faces');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Published ${files.length} faces. The site picks them up on its next build.`);
