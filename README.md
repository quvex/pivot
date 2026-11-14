# Pivot

A decision tool for one ESPN fantasy basketball **points** league. Every morning it pulls stats,
rankings, schedules, injuries and news from ten sources, projects every player for the rest of the
season, and turns that into the day's decisions: who to start, who to add, and which trades to make,
each with the reasoning behind it.

The projection model is tested the honest way: on three past NBA seasons, each scored by a version
tuned only on earlier seasons, with error ranges, an ablation of every piece, and a live track record.

<!-- Add a screenshot or short GIF of the front page and the trade builder here: docs/screenshot.png -->

## What it does

| Page | What you get |
|---|---|
| **Home** | Your standing, today's three most important moves, the players the market misprices most, and the best trade on the table |
| **This week** | Day-by-day best legal lineup with injury and return-date odds, games-cap pacing, and a cap line for when to sit a player |
| **Rankings** | Five ranking desks side by side with Pivot's own projection |
| **Trades** | Mock offers for any player or team, plus a builder for your own. Every offer comes with its argument, a for-and-against breakdown and charts |
| **Waivers** | Best available players matched against your weakest roster spots |
| **News** | Three days of player news ranked by how much it matters to your team, with an optional LLM-written briefing |

## Projection accuracy

`npm run backtest` replays past seasons day by day. At 13 checkpoints through each season it asks the
model for every relevant player's rest-of-season fantasy points per game, using only what was known
that day, then compares with what the player actually averaged afterwards.

**Rolling-origin evaluation.** Each test season is scored by a model tuned only on earlier seasons,
so nothing from the future leaks in. Figures are the mean absolute error in FP/G (lower is better).
The ranges are 95% intervals from a bootstrap that resamples whole players, because one player's
projections across a season are not independent.

| Test season | Tuned on | Pivot | Season average | Previous model | Gain over season average |
|---|---|---|---|---|---|
| 2023-24 | 2021-22 | **4.06** (3.76–4.37) | 4.68 | 4.12 | 13% |
| 2024-25 | 2021-22, 2023-24 | **3.79** (3.55–4.04) | 4.34 | 3.89 | 13% |
| 2025-26 | 2021-22, 2023-24, 2024-25 | **3.87** (3.64–4.10) | 4.37 | 3.99 | 11% |

All three seasons together (11,791 projections of 1,063 player-seasons):

| Method | MAE | 95% range | Worse than Pivot by |
|---|---|---|---|
| **Pivot model** | **3.90** | 3.76–4.06 | |
| Previous version of this model | 4.00 | 3.84–4.16 | 0.10 (0.06–0.14) |
| Season average to date | 4.46 | 4.28–4.65 | 0.56 (0.44–0.68) |
| Preseason projection | 5.26 | 5.02–5.52 | 1.36 (1.20–1.56) |
| Last 15 days | 5.74 | 5.61–5.88 | 1.84 (1.70–1.98) |

The gap to the season average, the number most fantasy players go by, is consistent across all
three seasons. The gain over the previous version of this model is real but small: 0.10 FP/G, and the
interval stays above zero.

2022-23 is not used, for tuning or testing, because ESPN's stored "preseason" projections for that
season were revised mid-season, which would leak the answer.

### Ablation: what each piece is worth

The full model with one piece taken away, pooled over the three test seasons. A positive change means
the model gets worse without it.

| Piece removed | MAE | Change (95% range) | Verdict |
|---|---|---|---|
| Preseason prior | 4.25 | +0.35 (0.25 to 0.44) | The biggest contributor |
| Minutes × efficiency split (one fantasy-points series instead, re-tuned) | 3.97 | +0.07 (0.04 to 0.11) | Helps |
| Recency weighting | 3.97 | +0.07 (0.02 to 0.12) | Helps |
| Top-end trim for stars | 3.91 | +0.01 (0.00 to 0.01) | Marginal |
| Shooting-luck correction | 3.91 | +0.00 (−0.02 to 0.03) | No measurable effect |

The shooting-luck correction is kept because it is cheap and harmless, but on this evidence it does
not earn its place. The live app also blends in FantasyPros' rest-of-season projection; there is no
history of that feed to replay, so it is not part of these numbers.

### Live track record

Backtests can be tuned, however carefully. So every daily update also saves its projections, and once
a snapshot is a week old each projection is scored against what the player has averaged since, next
to his season average on the day the projection was made. Results appear under Settings → Projection
accuracy as the season goes on. Logging started on 14 November 2026.

Known weak spot: the model runs about 1.5 to 2.5 FP/G high for the very best players (predicted 51.4,
actual 49.1 in the top band of 2025-26), mostly because stars get rested and shut down late in
seasons. The top-end trim corrects only a little of this.

### How the projection works

Fantasy points per game = minutes × points per minute, and the two behave differently. Minutes follow
role and change fast; per-minute production is a slow-moving skill. So `lib/estimator.mjs` estimates
each from the game log with its own recency half-life (28 days for minutes, 90 for efficiency), shrinks
both toward a preseason prior that fades as games pile up, corrects for shooting luck, then blends in
FantasyPros' rest-of-season projection. The half-lives, prior strengths and corrections are fitted by
coordinate descent in `lib/backtest.mjs` and stored in `lib/params.json`.

On top of that, `lib/model.mjs` redistributes production from injured players to teammates, estimates
games remaining from injury reports and a durability model (also fitted on past seasons), and converts
everything to value above replacement. In a games-capped league, replacement level comes from the
league's remaining games, not its roster spots.

## Trade engine

`lib/trade.mjs` judges a trade by what it does to your **projected final total**, not by adding up
points per game: it re-fills your remaining games cap with the new roster, forces drops or adds the
best free agent so roster sizes stay legal, and does the same for the other team. It also models how
the other manager will see the deal, using recent box scores, expert rank and draft position, plus a
premium for giving up the best player in the deal. That gives an acceptance estimate.

Each trade gets a short argument (the number, the best reason, the main risk) and a full breakdown
across production, form, role and minutes, availability, schedule, price, roster fit and the other
side. Confidence compares the edge with the model's measured error on those players.

The acceptance estimate is a heuristic. There is no data on real trade outcomes to test it against.

## Architecture

```mermaid
flowchart LR
  subgraph Sources
    ESPN[ESPN: players, game logs, league, injuries, schedule]
    Ranks[Hashtag · Basketball Monster · FantasyPros]
    News[RotoWire · Rotoworld · ESPN headlines]
    Crowd[Sleeper trends · RotoWire lineups]
  end
  Sources --> Refresh[lib/refresh.mjs<br>daily job]
  Refresh --> Model[lib/estimator.mjs + lib/model.mjs<br>projections, consensus, signals]
  Hist[(Past seasons<br>data/hist)] --> Backtest[lib/backtest.mjs] --> Params[(lib/params.json)] --> Model
  Model --> Latest[(data/latest.json)]
  Latest --> Server[server.mjs<br>JSON API, localhost only]
  Server --> Trade[lib/trade.mjs]
  Server --> UI[public/<br>vanilla JS single-page app]
```

- **No framework, one runtime dependency** (the Anthropic SDK, used only for the optional briefing).
  The server is Node's `http` module, and the UI is plain JavaScript with hand-drawn SVG charts.
- **Every source can fail on its own.** Each fetch is tracked, and a broken site shows up in Settings
  and the status bar without stopping the update.
- **Scrapers are split into fetch and parse.** The parsers are pure functions with unit tests; the live
  sites are checked separately with `npm run check:sources`.
- **Secrets stay local.** League cookies and API keys live in `data/settings.json` (owner-only
  permissions, git-ignored), are never sent back to the browser, and go only to the service they
  belong to. The server answers only requests addressed to localhost.

## Running it

Requires Node 20+.

```bash
npm install
npm start               # http://localhost:5178
```

Then open Settings and enter your ESPN league ID. A private league also needs your `espn_s2` and
`SWID` cookies.

```bash
npm test                # unit tests (node:test)
npm run lint            # ESLint
npm run backtest        # re-tune and re-score the projection model
npm run refresh         # run the daily update without the server
npm run check:sources   # hit every live source and report what it returned
```

## Data and terms

This is a personal tool. ESPN's fantasy API is unofficial, and the ranking and news sites are read
from their public pages. Check each site's terms before running it anywhere public, and credit the
sources if you publish anything built from them. No scraped data is committed to this repository.

## Project layout

```
server.mjs              web server and API
lib/sources.mjs         fetchers and parsers for every source
lib/history.mjs         season-long game logs from ESPN
lib/estimator.mjs       the per-game estimate shared by the live model and the backtest
lib/backtest.mjs        tuning, rolling-origin evaluation, bootstrap intervals, ablation
lib/livescore.mjs       scores saved daily projections against what happened since
lib/model.mjs           projections, consensus, market value, signals, waivers, weekly plan
lib/trade.mjs           trade evaluation and mock offers
lib/news.mjs            news classification, league outcomes, LLM briefing
lib/refresh.mjs         the daily job
public/                 the app
test/                   unit tests
scripts/                live source check
```
