# Prediction Market Backend

Backend starter for binary prediction markets on X Layer.

The first module is `src/markets`, which defines canonical market types:

- `YES_NO`
- `TOTAL_GOALS`
- `BOTH_TEAMS_TO_SCORE`

Supported fixture sports:

- `football`
- `basketball`
- `american_football`
- `esports`

All current market types map to two Conditional Tokens outcome slots:

- `indexSet: 1`
- `indexSet: 2`

## Football Markets

`TOTAL_GOALS` and `BOTH_TEAMS_TO_SCORE` are football-only market types. For a football fixture, the backend can generate:

- Total Goals Over/Under 0.5
- Total Goals Over/Under 1.5
- Total Goals Over/Under 2.5
- Total Goals Over/Under 3.5
- Both Teams To Score

Total goals markets intentionally use `.5` lines first, so there are no pushes.

Use `createFootballFixtureMarkets` for these generated football markets.

## Other Sports Markets

Basketball, American football, and esports fixtures are supported at the fixture/model layer. For now, these sports should use generic `YES_NO` markets until sport-specific market types are added.

Examples:

- Will Team A win map 1?
- Will Team B win the match?
- Will the series go to a final map?
- Will Team A cover the spread?
- Will the total score go over 44.5?

## Resolution Rules

```ts
totalGoals > line ? "OVER" : "UNDER";
homeGoals > 0 && awayGoals > 0 ? "YES" : "NO";
```

Generic `YES_NO` markets are the main market option and can be used outside football. They require an explicit oracle result because their winning side depends on the question text.

## API Sources

External APIs plug in through `MarketDataSource`:

```ts
interface MarketDataSource {
  readonly provider: string;
  listFixtures(query): Promise<Fixture[]>;
  getFixtureResult(externalFixtureId): Promise<ProviderFixtureResult>;
}
```

The backend resolution flow is intentionally guarded:

Market creation flow:

1. Register a `MarketDataSource`.
2. Fetch fixtures with `fetchFixturesFromSource`.
3. Generate supported markets with `createMarketsFromSource`.
4. Persist fixtures, markets, outcomes, and resolver configs.
5. Create each market on-chain through `MarketFactory.createBinaryMarket`.

Resolution flow:

1. Fetch the final result from the configured source.
2. Confirm the provider result belongs to the market fixture.
3. Compute a `ResolutionDecision`.
4. Mark it `reviewed`.
5. Submit the decision on-chain from the oracle wallet.
6. Mark it `submitted` after the transaction is accepted/indexed.

`ResolutionDecision.payoutVector` maps directly to Conditional Tokens oracle payouts:

- `NO` / `UNDER`: `[1, 0]`
- `YES` / `OVER`: `[0, 1]`

## Supabase Postgres

The backend can persist data with Prisma using Supabase Postgres. By default `DATABASE_ENABLED=false`, so local development still runs with the in-memory store.

Set these env vars to enable persistence:

```env
DATABASE_ENABLED=true
DATABASE_URL=
DIRECT_URL=
```

Use the Supabase pooled connection string for `DATABASE_URL`. Use the direct connection string for `DIRECT_URL`, which Prisma uses for migrations.

Common commands:

```sh
npm run prisma:generate
npm run prisma:deploy
npm test
```

## Automated Sync

Provider sync creates open core markets for featured fixtures. When on-chain sync is enabled, each open market without a `conditionId` is created through `MarketFactory.createBinaryMarket`, which also registers its outcome tokens with the CLOB exchange.

The default API-Football focus is the 2026 World Cup:

- `API_FOOTBALL_FEATURED_LEAGUE_IDS=1:2026` keeps automated football sync on 2026 World Cup fixtures by default.
- `API_FOOTBALL_SYNC_FIXTURE_DAYS=30` gives football sync enough look-ahead to create upcoming World Cup markets before kickoff week.
- Add other API-Football league ids only when they should join automated sync and on-chain market creation.

```env
SYNC_WORKER_ENABLED=true
SYNC_CREATE_MARKETS_ON_CHAIN=true
SYNC_ON_CHAIN_MARKET_LIMIT=50
```

`SYNC_ON_CHAIN_MARKET_LIMIT` caps contract writes per sync run. Markets that remain open without a `conditionId` are picked up by later runs.

## CLOB Trading API

Trading uses off-chain signed EIP-712 orders and operator-submitted matches on `CTFExchange`.

`Market.status` tracks lifecycle state, while `Market.tradingStatus` gates CLOB trading:

- `open` accepts and matches orders.
- `suspended` keeps a market inactive during a temporary trading hold.
- `closed` blocks further order entry and matching while settlement can still complete later.

Live football markets can remain tradable in-play. The settlement worker applies live lock rules from provider result data and closes trading when the market is already determined or its window has ended:

- first goal locks home-team-score-first markets
- half-time result locks first-half winner/draw markets
- both teams scoring locks both-teams-to-score markets
- a goal total above a `.5` line locks the total-goals market
- a tracked scorer event locks main-card player scorer markets for that player

Irreversible live results can resolve before the match ends. Early resolution is limited to confidence rules where later play cannot reverse the outcome:

- first-goal markets after the confirmed first scoring event
- total-goals `OVER` markets once the live score exceeds the `.5` line
- both-teams-to-score markets once both teams have scored
- main-card player-to-score markets after the tracked scorer event is confirmed with a stable provider `playerId`

The settlement worker applies a two-observation early-resolution policy before it submits on-chain:

- a repeated score observation confirms total-goals `OVER` and BTTS `YES`
- a repeated stable first-goal outcome confirms home-team-score-first
- a repeated stable scorer event with matching provider `playerId` confirms main-card player-to-score

The first observation stores an early resolution candidate and closes trading for that market. A matching later observation confirms the candidate and submits the resolver transaction when `SETTLEMENT_SUBMIT_ON_CHAIN=true`. Markets that can still reverse, such as match winner, draw, first-half winner before half-time, total-goals `UNDER`, BTTS `NO`, and player-to-score `NO`, wait for their normal settlement point.

1. `POST /clob/orders/readiness` checks the maker balance and exchange approval for the planned BUY or SELL order.
2. `POST /clob/orders/prepare` resolves `marketId + outcomeSide` to the on-chain token id and returns an unsigned order, typed data for the maker wallet, and the same readiness data.
3. The wallet signs the typed data and the client submits the signed order to `POST /clob/orders`.
4. The backend stores open orders and serves frontend market data routes.
5. The matcher checks accepted signed orders for crossing BUY/SELL liquidity on the same outcome and submits matches through the operator wallet.
6. Manual operator matching remains available through `POST /clob/matches`; trades, fills, and order remaining sizes are persisted.

Maker-wallet maintenance routes:

- `GET /clob/nonces/:maker` reads the exchange nonce.
- `POST /clob/nonces/increment-transaction` returns the wallet transaction that invalidates all orders at the current nonce.
- `POST /clob/orders/:id/cancel-transaction` returns the wallet transaction for a single order cancellation.
- `POST /clob/orders/:id/sync-status` refreshes backend order visibility after a cancellation or nonce change reaches the chain.

The exchange EIP-712 domain name remains the deployed contract domain used by `CTFExchange`; clients should sign the typed-data payload returned by the backend rather than hard-coding a renamed domain.

Order readiness uses the maker amount:

- `BUY` requires enough collateral balance and ERC20 allowance from the maker to `CTFExchange`.
- `SELL` requires enough Conditional Tokens balance for the outcome token id and ERC1155 operator approval from the maker to `CTFExchange`.

When approval is missing, readiness includes a wallet transaction payload for collateral `approve` or Conditional Tokens `setApprovalForAll`. Signed order submission rejects an order that is not ready, so unapproved or underfunded orders are not passed into automatic matching.

Automatic matching is enabled by default:

```env
CLOB_AUTO_MATCH_ENABLED=true
CLOB_AUTO_MATCH_MAX_MAKERS=10
```

The first matcher pass covers complementary `BUY` vs `SELL` orders for the same market outcome. It uses best maker price first and then earlier accepted order time. The exchange mint/merge path for matching complementary outcome buys or sells is still a later extension.

### Trading API Security

`POST /clob/matches` and `POST /clob/matcher/tick` are operator routes because they submit transactions through the backend operator wallet. Set a long random `CLOB_OPERATOR_API_KEY` and send it in the `x-operator-api-key` header for those routes.

Order entry is rate-limited per client IP on both `POST /clob/orders/prepare` and `POST /clob/orders`:

```env
CLOB_OPERATOR_API_KEY=
CLOB_ORDER_RATE_LIMIT_MAX=60
CLOB_ORDER_RATE_LIMIT_WINDOW=1 minute
```

Accepted order preparation and signed order submission events are written to Fastify logs with market, order, side, maker, and client IP fields. Signatures and API keys are not logged.

Frontend market data:

- `GET /events/markets` opens an SSE stream for live market state updates.
- `GET /markets/:id/orderbook` returns bid/ask levels and per-outcome price data.
- `GET /markets/:id/price` returns best bid, best ask, midpoint, spread, last trade, and volume for each outcome.
- `GET /markets/:id/trades?limit=100` returns normalized trade ticks plus stored trade/fill records.
- `GET /markets/:id/chart?interval=15m&limit=500` returns OHLC candles per outcome. Supported intervals are `1m`, `5m`, `15m`, `1h`, and `1d`.
- `GET /markets/:id/summary` returns the market, fixture when present, resolution when present, price map, counts, and volume totals.
- `POST /markets/:id/redeem-transaction` returns the Conditional Tokens redemption transaction payload after the winning outcome has been submitted on-chain.
- `GET /markets/summaries?status=open&sport=football&limit=100` batches card-sized summaries for market grids.
- `GET /markets/cards?status=open&sport=football&limit=100` groups summary snippets into match, player, and standalone market cards.

The batched summary and card routes can also filter by `fixtureId`. Sport filtering only includes markets attached to fixtures with that sport.

Discovery filters include:

- `q` text search over market titles and ids, fixture competitors, providers, resolver rules, outcome labels, and player identity fields.
- `provider` for the stored source provider such as `api-football`, `highlightly`, or `pandascore`.
- `fixtureStatus` for `scheduled`, `live`, `finished`, `postponed`, `cancelled`, or `abandoned`.
- `marketType` for `YES_NO`, `TOTAL_GOALS`, or `BOTH_TEAMS_TO_SCORE`.
- `category` for `match`, `player`, `main_player`, or `standalone`.
- `competitionId` and `competitionName` for normalized fixture competition metadata.

```text
/markets/cards?q=Ronaldo&category=player&status=open
/markets/summaries?provider=api-football&fixtureStatus=live&marketType=YES_NO
/markets/cards?competitionId=39&competitionName=premier
```

Fixtures carry normalized `competition` metadata when a provider supplies it. API-Football fixtures store league id/name/season, PandaScore fixtures prefer tournament id/name and fall back to league name, and Highlightly basketball fixtures store the configured match league/competition context.

Discovery routes use offset pagination:

```text
/markets/cards?sort=live_status&offset=0&limit=24
```

They return `pagination` with `offset`, `limit`, `total`, `hasMore`, and `nextOffset`. Sort with `kickoff_time`, `live_status`, `volume`, or `newest_activity`; `kickoff_time` defaults to ascending order, while the other discovery sorts default to descending order. Override with `direction=asc` or `direction=desc`.

The SSE stream sends a `stream.connected` event first and then named market events so the frontend can patch cards or refetch the affected market:

- `market.created`
- `market.trading_status_changed`
- `market.early_resolution_candidate`
- `market.resolution_submitted`
- `market.redeemable`
- `fixture.status_changed`
- `fixture.live_score_updated`

`market.redeemable` means a winning resolution has been submitted and position views should refresh; a wallet still needs the position balance before it can redeem.

## Portfolio API

User portfolio endpoints combine stored CLOB activity with current chain balances:

- `GET /portfolio/:account` returns collateral balance, positions, open and historical orders, trades, and fills.
- `GET /portfolio/:account/orders` returns the user's open and historical orders.
- `GET /portfolio/:account/trades` returns trades and fills touched by the user's orders.
- `GET /portfolio/:account/positions` returns collateral and per-market outcome token balances.

Portfolio and positions requests accept an optional comma-separated `marketIds` query value to limit chain balance reads:

```text
/portfolio/0x.../positions?marketIds=market-a,market-b
```

Position rows include outcome-token balances and resolution state. An outcome is marked `redeemable` when the backend has a submitted resolution for that outcome and the user holds a positive winning-token balance. Once it is redeemable, the frontend can request `POST /markets/:id/redeem-transaction` and ask the wallet to send the returned redemption payload.
