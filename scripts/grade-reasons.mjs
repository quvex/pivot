// Has the configured language model grade every injury-report wording it has not seen yet, and
// saves the grades to lib/reasons.json. Needs an OpenAI-compatible provider set in Settings.
//   node scripts/grade-reasons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadSettings } from '../lib/store.mjs';
import { compatibleJson } from '../lib/news.mjs';
import { gradeReasons } from '../lib/reasons.mjs';

const settings = loadSettings();
if (settings.aiProvider !== 'compatible' || !settings.altBaseUrl) { console.error('Set an OpenAI-compatible provider in Settings first.'); process.exit(1); }
const dir = path.join(DATA_DIR, 'reports');
const reasons = [];
for (const f of fs.readdirSync(dir)) for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) reasons.push(r.reason);
const ask = async (system, user) => (await compatibleJson(settings, system, user)).parsed;
const lex = await gradeReasons(reasons, ask, { log: console.log });
console.log(`${Object.keys(lex).length} wordings graded`);
