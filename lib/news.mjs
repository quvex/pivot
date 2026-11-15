// News: rule-based classification, league-specific outcomes, and the optional Claude briefing.
import Anthropic from '@anthropic-ai/sdk';
import { aiReady, isLocalUrl } from './store.mjs';
import { ownership } from './ownership.mjs';

export { ownership };

// First match wins, so order matters (most specific / most severe first).
const RULES = [
  ['season_ending', 'Out for season', 'bad', 4, /out for the (season|year)|season-ending|remainder of the (season|year)|miss the (rest|remainder) of/i],
  ['extended', 'Extended absence', 'bad', 3, /re-?evaluated in|out (for )?(at least |approximately |roughly )?(\w+ )?(to \w+ )?(weeks?|months?)|indefinitely|without a timetable|no timetable|undergo(ne)? surgery|will have surgery|multiple weeks/i],
  ['returning', 'Returning', 'good', 2, /will return|set to return|returns? (to action|to the lineup|from)|is available|good to go|has been cleared|cleared to play|off the injury report|upgraded to (available|probable)|will make his (season )?debut|will play (in )?(mon|tues|wednes|thurs|fri|satur|sun)day/i],
  ['out', 'Out', 'bad', 2, /ruled out|won't play|will not play|won't return|will not return|is out |remains out|will sit|sidelined|downgraded to out|won't suit up|exited|left (mon|tues|wednes|thurs|fri|satur|sun)day's game/i],
  ['questionable', 'Questionable', 'warn', 1, /questionable|doubtful|game-time (decision|call)|day-to-day|listed as probable|is probable/i],
  ['minutes_limit', 'Minutes limit', 'warn', 2, /minutes? (restriction|limit)|limited minutes|workload (restriction|management)/i],
  ['bench', 'Moved to bench', 'bad', 2, /com(e|ing) off the bench|move[sd]? to the bench|shift(s|ed|ing)? to the bench|removed from the starting|bench role|will not start|won't start|isn't starting|is not starting|not (listed )?in the starting|out of the starting/i],
  ['starting', 'Starting', 'good', 2, /will start|is starting|starting (mon|tues|wednes|thurs|fri|satur|sun)day|enter(s|ing)? the starting|move[sd]? into the starting|join(s|ing)? the starting|draw(s|ing)? the start|get(s|ting)? the start|in the starting (five|lineup)/i],
  ['transaction', 'Transaction', 'info', 2, /\btraded\b|has been acquired|waived|signed (a|to)|buyout|two-way|recalled|assigned to the g league/i],
  ['performance', 'Performance', 'info', 0, /career-high|triple-double|double-double|finished with|recorded|posted|tallied|notched|scored|supplied|contributed|chipped in|totaled|ended with|racked up|produced|accumulated|registered|logged|amassed|provided/i],
];

export function classify(headline, text = '') {
  // A box-score line ("21 points (6-11 FG, ...)") is a game recap whatever else it mentions.
  if (/\(\d+-\d+ FG/.test(headline)) return { tag: 'performance', label: 'Performance', tone: 'info', sev: 0 };
  // The headline carries the news; the body is analysis that mentions other statuses, so only
  // the unambiguous long-term tags are read from it.
  for (const [tag, label, tone, sev, re] of RULES) if (re.test(headline)) return { tag, label, tone, sev };
  for (const [tag, label, tone, sev, re] of RULES) {
    if (['season_ending', 'extended', 'minutes_limit'].includes(tag) && re.test(text)) return { tag, label, tone, sev };
  }
  return { tag: 'note', label: 'Note', tone: 'info', sev: 0 };
}

const availability = (p, own) => {
  const o = own.get(p.id);
  if (o.type === 'mine') return 'on your roster';
  if (o.type === 'team') return `rostered by ${o.team}`;
  if (o.type === 'fa') return 'a free agent in your league';
  return `${Math.round(p.owned)}% rostered`;
};
const addable = (p, own) => {
  const o = own.get(p.id);
  return o.type === 'fa' || (o.type === 'unknown' && p.owned < 60);
};

// Plain-language consequences of one news item for this league.
export function outcomesFor(item, byId, own, repl) {
  const p = byId.get(item.playerId);
  if (!p) return { relevance: 0, lines: [] };
  const o = own.get(p.id);
  const lines = [];
  let weak = false; // has a line, but nothing worth acting on
  const startable = p.model.fpg >= repl;
  const mates = [...byId.values()]
    .map((t) => ({ t, boost: t.model.boosts.find((b) => b.fromId === p.id) }))
    .filter((x) => x.boost)
    .sort((a, b) => b.boost.perGame - a.boost.perGame)
    .slice(0, 2);

  switch (item.tag) {
    case 'season_ending':
    case 'extended':
    case 'out': {
      const long = item.tag !== 'out' || p.avail.missed >= 4;
      if (o.type === 'mine') lines.push(long ? `Move ${p.name} to IR (${p.avail.note || 'out'}) and fill the slot.` : `Bench ${p.name} until he is cleared.`);
      else if (o.type === 'team' && long && item.tag !== 'season_ending' && p.model.fpg >= repl + 5) lines.push(`Buy-low window: ${o.team} may sell ${p.name} at a discount while he is out.`);
      else if (addable(p, own) && item.tag === 'extended' && p.model.fpg >= repl + 5) lines.push(`Stash candidate if you have an open IR slot (${p.model.fpg} FP/G when healthy).`);
      for (const { t, boost } of mates) {
        const gainNow = (boost.perGame * (1 - boost.baked)).toFixed(1);
        const what = own.get(t.id).type === 'mine' ? 'start him with confidence'
          : addable(t, own) ? (t.model.next >= repl - 2 ? 'worth an add' : 'deep-league watch only')
          : 'cost just went up';
        lines.push(`${t.name} (${availability(t, own)}) picks up usage${boost.baked < 1 ? `, about +${gainNow} FP/G` : ' (already showing in his numbers)'}: ${what}.`);
      }
      break;
    }
    case 'questionable':
      if (o.type === 'mine') lines.push(`Check ${p.name}'s status before lock and have a bench option ready.`);
      break;
    case 'returning':
      if (o.type === 'mine') lines.push(`Get ${p.name} back in your lineup (${p.model.fpg} FP/G projected).`);
      else if (addable(p, own) && startable) lines.push(`${p.name} is ${availability(p, own)} and projects for ${p.model.fpg} FP/G: add him.`);
      for (const t of byId.values()) {
        const hit = t.model.boosts.find((b) => b.fromId === p.id && b.baked > 0);
        if (hit && own.get(t.id).type === 'mine') lines.push(`${t.name}'s bump ends, about -${(hit.perGame * hit.baked).toFixed(1)} FP/G: consider selling high.`);
      }
      break;
    case 'starting':
      if (o.type === 'mine') lines.push(`${p.name} holds extra value while he starts: keep him active.`);
      else if (addable(p, own)) lines.push(startable ? `${p.name} is ${availability(p, own)} and starting: add him (${p.model.next} FP/G near term).` : `${p.name} is starting but projects below replacement (${p.model.next} FP/G): streamer only.`);
      if (!startable && o.type !== 'mine') weak = true;
      break;
    case 'bench':
    case 'minutes_limit':
      if (o.type === 'mine') lines.push(`${p.name}'s floor drops${item.tag === 'bench' ? ' in a bench role' : ' on a minutes limit'}: bench him if you have a comparable option.`);
      else if (o.type === 'team' && p.model.fpg >= repl + 6 && item.tag === 'minutes_limit') lines.push(`Short-term dip only: a quiet time to ask ${o.team} about ${p.name}.`);
      break;
    case 'performance':
      if (p.signal?.type === 'sell' && o.type === 'mine') lines.push(`Big line on top of a hot stretch: his trade value may never be higher. ${p.signal.reasons[0]}.`);
      else if (addable(p, own) && startable) lines.push(`${p.name} is ${availability(p, own)} and producing (${p.model.fpg} FP/G projected): add him.`);
      break;
    case 'transaction':
      if (o.type === 'mine' || addable(p, own)) lines.push(`Role change possible for ${p.name}: watch his minutes over the next two games before acting.`);
      break;
  }
  let relevance = o.type === 'mine' ? 3 : 0;
  if (!relevance && lines.length) relevance = addable(p, own) && !weak ? 2 : 1;
  if (!relevance && mates.some(({ t }) => own.get(t.id).type === 'mine')) relevance = 2;
  if (!lines.length && p.model.rank <= 150) lines.push(o.type === 'mine' ? 'No lineup change needed.' : `No action needed: ${p.name} is ${availability(p, own)}.`);
  return { relevance, lines };
}

// ---------- optional: Claude-written briefing ----------
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['briefing', 'items'],
  properties: {
    briefing: { type: 'array', items: { type: 'string' }, description: '3 to 6 one-sentence takeaways for this manager, most important first' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'outcome'],
        properties: { id: { type: 'string' }, outcome: { type: 'string', description: 'One sentence, under 30 words: what this manager should do or expect' } },
      },
    },
  },
};

const SYSTEM = 'You advise one manager in an ESPN fantasy basketball points league. You get today\'s player news with model projections and who rosters each player. '
  + 'Write concrete, league-specific outcomes: who to add, drop, start, sit, buy or sell, and why in a few words. Use only the facts provided; if a news item does not change anything for this manager, say so plainly. '
  + 'Plain sentences, no hype. "FP/G" means fantasy points per game under this league\'s scoring.';

// Any service that speaks the OpenAI chat-completions format: Gemini, Groq, OpenRouter, a local Ollama...
async function compatibleBriefing(settings, user) {
  return compatibleJson(settings, `${SYSTEM} Reply with one JSON object only, shaped {"briefing": [3 to 6 one-sentence takeaways, most important first], "items": [{"id": "<news item id>", "outcome": "<one sentence under 30 words>"}]}.`, user);
}

// One JSON answer from the configured OpenAI-compatible provider.
export async function compatibleJson(settings, system, user) {
  const base = String(settings.altBaseUrl).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !isLocalUrl(base)) throw new Error('The API address must start with https:// (or be a local http://localhost address)');
  // busy or rate-limited providers usually recover within seconds: try three times
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 8000));
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(settings.altKey ? { Authorization: `Bearer ${settings.altKey}` } : {}) },
      body: JSON.stringify({
        model: settings.altModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (res.status !== 503 && res.status !== 429 && res.status !== 500) break;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${new URL(base).hostname} responded ${res.status}${res.status === 401 || res.status === 403 ? ': check the API key' : res.status === 404 ? ': check the address and model name' : res.status === 429 ? ': rate limit or quota reached' : res.status === 503 ? ': the model is overloaded, try again shortly or pick another model' : ''} ${body.slice(0, 140)}`.trim());
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('The model returned no text');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not return JSON');
  return { parsed: JSON.parse(text.slice(start, end + 1)), model: json.model || settings.altModel };
}

export async function aiBriefing(news, data, settings) {
  const compatible = settings.aiProvider === 'compatible';
  const apiKey = settings.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!aiReady(settings) || !news.length) return null;
  const own = ownership(data, settings);
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const describe = (p) => `${p.name} (${p.team} ${p.pos}, model ${p.model.fpg} FP/G, rank ${p.model.rank}, ${availability(p, own)}${p.avail.note ? `, ${p.avail.note}` : ''})`;
  const items = news.slice(0, 45).map((n) => {
    const p = byId.get(n.playerId);
    const mates = p ? data.players.filter((t) => t.model.boosts.some((b) => b.fromId === p.id)).slice(0, 3).map(describe) : [];
    return { id: n.id, tag: n.label, player: p ? describe(p) : n.headline, news: `${n.headline} ${n.text}`.slice(0, 600), teammatesAffected: mates };
  });
  const roster = data.players.filter((p) => own.mine.has(p.id)).map(describe);
  const scoring = Object.entries(data.meta.scoring).map(([k, v]) => `${data.meta.statLabels[k] || k} ${v > 0 ? '+' : ''}${v}`).join(', ');

  const user = `League scoring: ${scoring}\n\nMy roster:\n${roster.length ? roster.join('\n') : '(not set: give general points-league advice)'}\n\nReplacement level: ${data.meta.repl} FP/G\n\nToday's news items (JSON):\n${JSON.stringify(items)}\n\nReturn an overall briefing for me and one outcome per news item id.`;
  const pack = (parsed, model) => ({
    briefing: (parsed.briefing || []).map(String).slice(0, 8),
    outcomes: Object.fromEntries((parsed.items || []).filter((i) => i && i.id && i.outcome).map((i) => [String(i.id), String(i.outcome)])),
    model, at: new Date().toISOString(),
  });
  if (compatible) {
    const { parsed, model } = await compatibleBriefing(settings, user);
    return pack(parsed, model);
  }

  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: settings.aiModel || 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined the briefing request');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error(`Claude returned no text (stop_reason ${response.stop_reason})`);
  return pack(JSON.parse(text), response.model);
}
