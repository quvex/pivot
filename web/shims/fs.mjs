// Stand-in for node:fs in the browser bundle. The engine reads two files that ship with the code
// (the tuned model parameters and the injury-reason grades); those are bundled in. Everything else
// reads as missing, which every caller already handles (no history, no cache), and writes do nothing.
import params from '../../lib/params.json';
import reasons from '../../lib/reasons.json';

const FILES = { 'params.json': JSON.stringify(params), 'reasons.json': JSON.stringify(reasons) };
const missing = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
const base = (file) => String(file).split('/').pop();
const nothing = () => {};

export function readFileSync(file) { const f = FILES[base(file)]; if (f == null) throw missing(file); return f; }
export const existsSync = (file) => base(file) in FILES;
export function readdirSync(dir) { throw missing(dir); }
export function statSync(file) { throw missing(file); }
export const writeFileSync = nothing, mkdirSync = nothing, renameSync = nothing, unlinkSync = nothing, rmSync = nothing;
export default { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync };
