// The ESPN cookie relay for the public site (a Cloudflare Worker, free plan).
//
// A browser can't attach espn.com cookies to a request from another site, so a visitor who pastes
// their espn_s2 and SWID sends them here in two headers, and this passes them to ESPN's league API
// as cookies. It only forwards reads of one fantasy basketball league (settings, rosters, and its
// trade log), only for pages on the allowed sites, and stores and logs nothing.
const ESPN = 'https://lm-api-reads.fantasy.espn.com';
const PATH = /^\/apis\/v3\/games\/fba\/seasons\/\d{4}\/segments\/0\/leagues\/\d{1,12}(\/communication\/)?$/;
const ORIGINS = /^(https:\/\/quvex\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    if (!ORIGINS.test(origin)) return new Response('Forbidden', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'x-espn-s2, x-espn-swid, x-fantasy-filter', 'Access-Control-Max-Age': '600' } });
    }
    const url = new URL(req.url);
    if (req.method !== 'GET' || !PATH.test(url.pathname)) return new Response('Not found', { status: 404, headers: cors });
    const s2 = req.headers.get('x-espn-s2') || '', swid = req.headers.get('x-espn-swid') || '';
    if (!/^[A-Za-z0-9%+/=_.-]{20,800}$/.test(s2) || !/^\{?[A-Fa-f0-9-]{36}\}?$/.test(swid)) {
      return new Response(JSON.stringify({ error: 'Those do not look like ESPN cookies.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const headers = { Cookie: `espn_s2=${s2}; SWID=${swid}`, Accept: 'application/json' };
    const filter = req.headers.get('x-fantasy-filter');
    if (filter) headers['X-Fantasy-Filter'] = filter.slice(0, 4000);
    const res = await fetch(`${ESPN}${url.pathname}${url.search}`, { headers });
    return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  },
};
