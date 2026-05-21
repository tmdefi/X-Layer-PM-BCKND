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
```

## Automated Sync

Provider sync creates open core markets for featured fixtures. When on-chain sync is enabled, each open market without a `conditionId` is created through `MarketFactory.createBinaryMarket`, which also registers its outcome tokens with the CLOB exchange.

```env
SYNC_WORKER_ENABLED=true
SYNC_CREATE_MARKETS_ON_CHAIN=true
SYNC_ON_CHAIN_MARKET_LIMIT=50
```

`SYNC_ON_CHAIN_MARKET_LIMIT` caps contract writes per sync run. Markets that remain open without a `conditionId` are picked up by later runs.
