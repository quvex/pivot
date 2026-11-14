// Assembles the static public demo in site/: the app's front end in demo mode, the browser-safe
// parts of the trade engine, and the scrubbed snapshot from demo/state.json.
//   npm run demo:build      then serve site/ with any static file server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const from = (...p) => path.join(ROOT, ...p);

if (!fs.existsSync(from('demo', 'state.json'))) throw new Error('demo/state.json is missing. Run npm run demo:snapshot first.');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });

fs.cpSync(from('public'), OUT, { recursive: true });
for (const f of ['trade.mjs', 'ownership.mjs']) fs.copyFileSync(from('lib', f), path.join(OUT, 'lib', f));
fs.copyFileSync(from('demo', 'state.json'), path.join(OUT, 'state.json'));

const html = fs.readFileSync(from('public', 'index.html'), 'utf8');
const demoHtml = html
  .replace('<html lang="en">', '<html lang="en" data-demo="true">')
  .replace('<title>Pivot</title>', '<title>Pivot · Demo</title>\n  <meta name="description" content="Pivot: a fantasy basketball decision tool. Live demo on a frozen league snapshot.">');
if (demoHtml === html) throw new Error('Could not switch index.html into demo mode');
fs.writeFileSync(path.join(OUT, 'index.html'), demoHtml);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Built site/ (${(size(OUT) / 1e6).toFixed(2)} MB)`);
