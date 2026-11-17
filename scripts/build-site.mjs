// Assembles the public site in site/: the live app at the root and the frozen demo under demo/.
// The live app has no server: it runs Pivot's engine in the visitor's browser (web/engine.mjs) on
// the day's shared pull, which a GitHub Action makes with scripts/daily-pull.mjs.
//   node scripts/build-site.mjs <pull-dir>     (the folder holding latest.json and raw.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildDemo, dirSize } from './build-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const pull = path.resolve(process.argv[2] || path.join(ROOT, 'data'));
for (const f of ['latest.json', 'raw.json']) if (!fs.existsSync(path.join(pull, f))) throw new Error(`${f} is missing from ${pull}. Run scripts/daily-pull.mjs first.`);

// Node-only modules the engine imports, swapped for browser stand-ins
const SHIMS = { fs: 'fs.mjs', 'node:fs': 'fs.mjs', path: 'path.mjs', 'node:path': 'path.mjs', url: 'url.mjs', 'node:url': 'url.mjs', '@anthropic-ai/sdk': 'anthropic.mjs' };
const shims = {
  name: 'shims',
  setup(b) {
    b.onResolve({ filter: /^(node:)?(fs|path|url)$|^@anthropic-ai\/sdk$/ }, (a) => ({ path: path.join(ROOT, 'web', 'shims', SHIMS[a.path]) }));
    b.onResolve({ filter: /^pdfjs-dist/ }, (a) => ({ path: a.path, external: true })); // reports are parsed on GitHub, never here
  },
};

export async function buildSite() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'web', 'engine.mjs')], outfile: path.join(OUT, 'engine.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
    plugins: [shims], define: { 'process.env': '{}', 'process.argv': '[]' }, logLevel: 'warning',
  });
  fs.copyFileSync(path.join(pull, 'latest.json'), path.join(OUT, 'data.json'));
  fs.copyFileSync(path.join(pull, 'raw.json'), path.join(OUT, 'raw.json'));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // the ESPN cookie relay's address (worker/), for private leagues; without it they need an espn.com sign-in
  const relay = process.env.PIVOT_ESPN_RELAY || '';
  if (relay && !/^(https:\/\/[\w.-]+|http:\/\/localhost:\d+)(\/[\w./-]*)?$/.test(relay)) throw new Error('PIVOT_ESPN_RELAY must be an https address');
  const live = html.replace('<html lang="en">', `<html lang="en" data-web="true"${relay ? ` data-espn-relay="${relay}"` : ''}>`)
    .replace('<title>Pivot</title>', '<title>Pivot</title>\n  <meta name="description" content="Pivot: fantasy basketball for ESPN points leagues. Rankings, trades with reasoning, waivers and a weekly plan for your own league.">');
  if (live === html) throw new Error('Could not switch index.html into web mode');
  fs.writeFileSync(path.join(OUT, 'index.html'), live);
  // published faces (the faces branch, checked out by the workflow; data/heads when built locally)
  const faces = path.resolve(process.env.PIVOT_FACES_DIR || path.join(ROOT, 'data', 'heads'));
  const heads = fs.existsSync(faces) ? fs.readdirSync(faces).filter((f) => /^\d+\.glb$/.test(f)) : [];
  fs.mkdirSync(path.join(OUT, 'heads'), { recursive: true });
  for (const f of heads) fs.copyFileSync(path.join(faces, f), path.join(OUT, 'heads', f));
  fs.writeFileSync(path.join(OUT, 'heads', 'index.json'), JSON.stringify(heads.map((f) => Number(f.slice(0, -4)))));
  buildDemo(path.join(OUT, 'demo'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  return OUT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildSite();
  console.log(`Built site/ (${(dirSize(OUT) / 1e6).toFixed(2)} MB)`);
}
