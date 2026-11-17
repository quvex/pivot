// Stand-in for node:path in the browser bundle: just enough for building file names.
const clean = (parts) => {
  const out = [];
  for (const p of parts.join('/').split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return `/${out.join('/')}`;
};
export const sep = '/';
export const join = (...p) => clean(p);
export const resolve = (...p) => clean(p);
export const normalize = (p) => clean([p]);
export const dirname = (p) => clean([p, '..']);
export const basename = (p) => String(p).split('/').pop();
export const extname = (p) => { const m = /\.[^./]*$/.exec(basename(p)); return m ? m[0] : ''; };
export default { sep, join, resolve, normalize, dirname, basename, extname };
