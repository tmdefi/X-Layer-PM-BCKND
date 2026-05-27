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
- `mma`

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

Basketball and MMA currently use binary fighter/team winner `YES_NO` markets. American football and esports fixtures are supported at the fixture/model layer and should use generic `YES_NO` markets until sport-specific market types are added.

UFC fights come from API-Sports API-MMA through provider `api-mma`. The backend generates one fighter-win market for each side of a UFC fight and resolves draw/no-contest style finished results as `VOID` until a single winner is present.

```env
API_MMA_KEY=
API_MMA_BASE_URL=https://v1.mma.api-sports.io
API_MMA_PROMOTION_FILTER=UFC
```

`API_MMA_KEY` falls back to `API_FOOTBALL_KEY` because both providers use API-Sports authentication. Set `API_MMA_PROMOTION_FILTER` to the promotion label present in API-MMA fight competition data; the default keeps the source focused on UFC fights.

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
4. Mark it `reviewed` with `POST /markets/:id/review-resolution`.
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

## Railway Deployment

This repo includes `railway.json` for Railway/Nixpacks deployment. Railway should run:

```sh
npm run prisma:generate && npm run build
HOST=0.0.0.0 npm run start
```

The `/health` route is used as the deployment health check.

Recommended Railway setup:

1. Create a Railway project and deploy this backend repo or the `backend` directory.
2. Add Railway Postgres and set `DATABASE_ENABLED=true`.
3. Set `DATABASE_URL` from the Railway Postgres connection string. Set `DIRECT_URL` too if you want to run Prisma migrations from Railway.
4. Run `npm run prisma:deploy` once after Postgres is attached and the database env vars are present.
5. Add the X Layer, contract, provider API, and operator env vars from `.env.example`.

For production-like testnet behavior, use `HOST=0.0.0.0`, keep `PORT` unset so Railway can inject it, and only enable `SETTLEMENT_SUBMIT_ON_CHAIN=true` when the backend wallet is funded and intended to submit resolver transactions.

## Telegram Privy Wallets

The backend can expose protected Telegram-bot routes that create Privy Ethereum wallets and place CLOB orders from those wallets. These routes are intended for the Telegram bot service only; do not call them directly from a public client.

Required env vars:

```env
TELEGRAM_BOT_API_KEY=
PRIVY_SERVER_WALLETS_ENABLED=true
PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_WALLET_SIGNER_ID=
PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY=
PRIVY_WALLET_POLICY_ID=
```

Bot requests must include:

```text
x-telegram-bot-api-key: <TELEGRAM_BOT_API_KEY>
```

Routes:

```text
POST /telegram/wallet
POST /telegram/orders
```

`/telegram/wallet` imports or finds the Telegram user in Privy and returns the user's deposit wallet address. `/telegram/orders` checks balance/approval, submits a Privy approval transaction if required, signs the CLOB EIP-712 order with Privy, and submits it into the backend CLOB.

## Wallet Connection

The frontend can bootstrap wallet connection from the public backend config route:

```text
GET /wallet/config
```

It returns the X Layer chain id in decimal and wallet hex form, public RPC data, the `wallet_addEthereumChain` payload, configured market contract addresses, the CLOB order-signing domain, and capability flags for approvals and redemption payloads. Backend keys and operator API credentials are never returned.

Frontend flow:

1. Request wallet accounts from the injected wallet or chosen wallet connector.
2. Fetch `/wallet/config`.
3. Switch to `walletAddEthereumChain.chainId`; if the wallet does not know the chain, add it with `walletAddEthereumChain`.
4. Use the connected account for order readiness, order preparation, typed-data signing, approval payloads, cancellations, and redemption payloads.

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

Settlement API polling is live-first to protect provider quota:

- featured live fixtures are checked on the settlement worker interval
- fixtures tracked as live and then missing from the live feed get an immediate result check
- stored finished, cancelled, abandoned, or postponed fixtures get a result check and then settle once
- scheduled fixtures far from kickoff do not get per-minute result checks
- scheduled fixtures near kickoff use the slower fallback window below

```env
SETTLEMENT_NEAR_KICKOFF_WINDOW_MINUTES=180
SETTLEMENT_NEAR_KICKOFF_FALLBACK_INTERVAL_SECONDS=300
```

Set `SETTLEMENT_NEAR_KICKOFF_FALLBACK_INTERVAL_SECONDS=0` to rely only on live feed and terminal fixture status for scheduled fixtures.

API-Football main-card player candidate ranking caches team stats by provider league, player-stat season, and team. That keeps repeated fixtures for the same World Cup team from rerunning the `/players` fan-out every time player scorer markets are prepared:

```env
PLAYER_CANDIDATE_CACHE_SCHEDULED_SECONDS=21600
PLAYER_CANDIDATE_CACHE_NEAR_KICKOFF_SECONDS=3600
PLAYER_CANDIDATE_CACHE_NEAR_KICKOFF_WINDOW_MINUTES=1440
```

The fixture lookup still happens when candidates are requested, but the expensive per-team player-stat ranking work reuses the persisted cache. Live trading and settlement do not refresh player candidate rankings.

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

The same operator header protects backend-owned mutation routes for provider sync, settlement ticks, fixture and market creation, on-chain market creation, resolution computation, review, and submission. Source fixture reads also require it when `persist=true` or `createMarkets=true` asks the backend to write fetched data.

Order entry is rate-limited per client IP on both `POST /clob/orders/prepare` and `POST /clob/orders`:

```env
CLOB_OPERATOR_API_KEY=
CLOB_ORDER_RATE_LIMIT_MAX=60
CLOB_ORDER_RATE_LIMIT_WINDOW=1 minute
```

Accepted order preparation and signed order submission events are written to Fastify logs with market, order, side, maker, and client IP fields. Signatures and API keys are not logged.

### Operator Transactions

Backend-submitted chain actions are recorded in the database before they are sent and updated as the operator wallet broadcasts or confirms them:

- market creation records `CREATE_MARKET`
- CLOB matching records `MATCH_ORDERS`
- resolver submission records `SUBMIT_RESOLUTION`

Statuses are `attempted`, `pending`, `confirmed`, and `failed`. `pending` rows include the broadcast transaction hash when the chain wrapper receives it, and a still-active transaction for the same action/entity blocks a duplicate submit path.

The protected operator endpoint exposes recent records:

```text
GET /operator/transactions?status=pending&action=SUBMIT_RESOLUTION
```

Send the same `x-operator-api-key` header used for matcher operator routes. The next reliability step after this ledger is receipt polling and retry/recovery for records that remain pending or failed after RPC disruption or backend restart.

A partial recovery loop is enabled by default:

```env
OPERATOR_TX_RECOVERY_WORKER_ENABLED=true
OPERATOR_TX_RECOVERY_POLL_INTERVAL_SECONDS=60
OPERATOR_TX_RECOVERY_LIMIT=100
```

It checks saved `pending` operator transaction receipts, marks successful receipts `confirmed`, marks reverted receipts `failed`, restores submitted resolution state, and recovers a created market `conditionId` from on-chain state when needed.

Confirmed `MATCH_ORDERS` rows also recover CLOB bookkeeping from the saved match metadata when a crash happens after the exchange transaction but before local trade persistence:

- reconstruct the taker/maker match plan
- record the missing trade and fills
- update remaining maker sizes and order statuses
- store the recovered trade id, tx hash, and order statuses in the operator transaction result

CLOB recovery is idempotent by transaction hash: a trade already recorded for that exchange tx is not replayed, and the database enforces one stored trade per match tx hash.

Operator retries are deliberately narrow:

- an action with a broadcast tx hash remains `pending` if receipt waiting fails, so recovery checks the saved hash before any new submit
- a reverted broadcast tx becomes terminal `failed` after recovery sees the receipt and is not blindly resubmitted
- a no-hash failed market creation or match may use its normal fresh submit path again
- a no-hash failed resolution requires the protected operator retry route

Transaction listing includes a `retryPolicy` payload explaining the disposition. Manual resolution retry:

```text
POST /operator/transactions/:id/retry-resolution
```

Send `x-operator-api-key`. The route only accepts failed `SUBMIT_RESOLUTION` rows with no recorded tx hash and creates a new tracked submit attempt from the saved resolution.

Operator recovery visibility and manual ticking:

```text
GET /operator/recovery/status
POST /operator/recovery/tick
```

The manual tick route is protected with `x-operator-api-key`.

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
