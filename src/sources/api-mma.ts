import { env } from "../config/env.js";
import type { Fixture, FixtureStatus, ProviderFixtureResult } from "../markets/types.js";
import type { FixtureQuery, MarketDataSource } from "./types.js";

type ApiMmaFighter = {
  id?: number | string | null;
  name?: string | null;
  winner?: boolean | null;
  logo?: string | null;
  image?: string | null;
  photo?: string | null;
};

type ApiMmaNamedRef = {
  id?: number | string | null;
  name?: string | null;
};

type ApiMmaFight = {
  id: number | string;
  date?: string | null;
  timestamp?: number | null;
  slug?: string | null;
  status?: string | { short?: string | null; long?: string | null } | null;
  league?: ApiMmaNamedRef | string | null;
  category?: ApiMmaNamedRef | string | null;
  event?: ApiMmaNamedRef | string | null;
  fighters?: {
    first?: ApiMmaFighter | null;
    second?: ApiMmaFighter | null;
    home?: ApiMmaFighter | null;
    away?: ApiMmaFighter | null;
    red?: ApiMmaFighter | null;
    blue?: ApiMmaFighter | null;
  } | null;
  teams?: {
    home?: ApiMmaFighter | null;
    away?: ApiMmaFighter | null;
  } | null;
  fighter1?: ApiMmaFighter | null;
  fighter2?: ApiMmaFighter | null;
  winner?: ApiMmaFighter | string | number | null;
  result?: { winner?: ApiMmaFighter | string | number | null } | null;
  results?: { winner?: ApiMmaFighter | string | number | null } | null;
};

type ApiMmaResponse<T> = {
  response: T[];
  paging?: {
    current: number;
    total: number;
  };
  errors?: unknown;
};

export class ApiMmaSource implements MarketDataSource {
  readonly provider = "api-mma";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = env.API_MMA_BASE_URL,
    private readonly promotionFilter = env.API_MMA_PROMOTION_FILTER
  ) {}

  async listFixtures(query: FixtureQuery): Promise<Fixture[]> {
    if (query.sport && query.sport !== "mma") return [];

    const params = new URLSearchParams();
    if (query.externalFixtureId) params.set("id", query.externalFixtureId);
    if (query.from && (!query.to || query.to === query.from)) {
      params.set("date", query.from);
    } else {
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
    }

    const fights = await this.request<ApiMmaFight>("/fights", params);
    return fights
      .filter((fight) => !this.promotionFilter || isPromotionFight(fight, this.promotionFilter))
      .map((fight) => this.toFixture(fight))
      .filter(isFixture);
  }

  async listLiveFixtures(): Promise<Fixture[]> {
    const fights = await this.request<ApiMmaFight>("/fights", new URLSearchParams({ live: "all" }));
    return fights
      .filter((fight) => !this.promotionFilter || isPromotionFight(fight, this.promotionFilter))
      .map((fight) => this.toFixture(fight))
      .filter(isFixture);
  }

  async getFixtureResult(externalFixtureId: string): Promise<ProviderFixtureResult> {
    const [fight] = await this.request<ApiMmaFight>("/fights", new URLSearchParams({ id: externalFixtureId }));
    if (!fight) throw new Error(`API-MMA fight not found: ${externalFixtureId}`);

    const [home, away] = fightFighters(fight);
    if (!home || !away) throw new Error(`API-MMA fight is missing two fighters: ${externalFixtureId}`);

    const result: ProviderFixtureResult = {
      source: this.sourceRef(fight),
      fixtureId: this.fixtureId(fight.id),
      status: mapFightStatus(statusLabel(fight.status)),
      observedAt: new Date().toISOString()
    };

    if (result.status === "finished") {
      const winner = fightWinner(fight, home, away);
      result.score =
        winner === "home"
          ? { homeGoals: 1, awayGoals: 0 }
          : winner === "away"
            ? { homeGoals: 0, awayGoals: 1 }
            : { homeGoals: 0, awayGoals: 0 };
    }

    return result;
  }

  private async request<T>(path: string, params: URLSearchParams): Promise<T[]> {
    if (!this.apiKey) throw new Error("API_MMA_KEY or API_FOOTBALL_KEY is required to use API-MMA");

    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const response = await fetch(url, {
      headers: {
        "x-apisports-key": this.apiKey
      }
    });
    if (!response.ok) {
      throw new Error(`API-MMA request failed with ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as ApiMmaResponse<T>;
    if (body.errors && hasApiErrors(body.errors)) {
      throw new Error(`API-MMA returned errors: ${JSON.stringify(body.errors)}`);
    }
    return body.response ?? [];
  }

  private toFixture(fight: ApiMmaFight): Fixture | undefined {
    const [home, away] = fightFighters(fight);
    if (!home?.name || !away?.name) return undefined;

    const kickoffTime = fight.timestamp
      ? new Date(fight.timestamp * 1000).toISOString()
      : fight.date
        ? new Date(fight.date).toISOString()
        : undefined;
    if (!kickoffTime || Number.isNaN(Date.parse(kickoffTime))) return undefined;

    const competition = competitionRef(fight);
    return {
      id: this.fixtureId(fight.id),
      sport: "mma",
      source: this.sourceRef(fight),
      ...(competition ? { competition } : {}),
      homeCompetitor: home.name,
      awayCompetitor: away.name,
      ...(fighterImage(home) ? { homeLogoUrl: fighterImage(home) } : {}),
      ...(fighterImage(away) ? { awayLogoUrl: fighterImage(away) } : {}),
      kickoffTime,
      status: mapFightStatus(statusLabel(fight.status))
    };
  }

  private sourceRef(fight: ApiMmaFight) {
    return {
      provider: this.provider,
      externalFixtureId: String(fight.id),
      sourceUrl: `${this.baseUrl}/fights?id=${fight.id}`,
      fetchedAt: new Date().toISOString()
    };
  }

  private fixtureId(externalFixtureId: number | string): string {
    return `api-mma:${externalFixtureId}`;
  }
}

export function createApiMmaSource(): ApiMmaSource | undefined {
  const apiKey = env.API_MMA_KEY || env.API_FOOTBALL_KEY;
  if (!apiKey) return undefined;
  return new ApiMmaSource(apiKey);
}

function fightFighters(fight: ApiMmaFight): [ApiMmaFighter | undefined, ApiMmaFighter | undefined] {
  return [
    fight.fighters?.first ?? fight.fighters?.home ?? fight.fighters?.red ?? fight.teams?.home ?? fight.fighter1 ?? undefined,
    fight.fighters?.second ?? fight.fighters?.away ?? fight.fighters?.blue ?? fight.teams?.away ?? fight.fighter2 ?? undefined
  ];
}

function fightWinner(
  fight: ApiMmaFight,
  home: ApiMmaFighter,
  away: ApiMmaFighter
): "home" | "away" | undefined {
  if (home.winner) return "home";
  if (away.winner) return "away";

  const winner = fight.winner ?? fight.result?.winner ?? fight.results?.winner;
  if (fighterMatches(home, winner)) return "home";
  if (fighterMatches(away, winner)) return "away";
  return undefined;
}

function fighterMatches(fighter: ApiMmaFighter, candidate: ApiMmaFighter | string | number | null | undefined): boolean {
  if (candidate === null || candidate === undefined) return false;
  if (typeof candidate === "number" || typeof candidate === "string") {
    return String(fighter.id ?? "") === String(candidate) || normalized(fighter.name) === normalized(String(candidate));
  }
  return (
    (candidate.id !== undefined && candidate.id !== null && String(fighter.id ?? "") === String(candidate.id)) ||
    normalized(fighter.name) === normalized(candidate.name)
  );
}

function competitionRef(fight: ApiMmaFight): Fixture["competition"] | undefined {
  const competition = namedRef(fight.event) ?? namedRef(fight.league) ?? namedRef(fight.slug) ?? namedRef(fight.category);
  if (!competition?.name) return undefined;
  return {
    kind: "competition",
    ...(competition.id ? { id: competition.id } : {}),
    name: competition.name
  };
}

function isPromotionFight(fight: ApiMmaFight, promotion: string): boolean {
  const needle = promotion.toLowerCase();
  return [fight.event, fight.league, fight.slug, fight.category]
    .map(namedRef)
    .some((value) => value?.name.toLowerCase().includes(needle));
}

function namedRef(value: ApiMmaNamedRef | string | null | undefined): { id?: string; name: string } | undefined {
  if (typeof value === "string") return value ? { name: value } : undefined;
  if (!value?.name) return undefined;
  return {
    ...(value.id !== undefined && value.id !== null ? { id: String(value.id) } : {}),
    name: value.name
  };
}

function statusLabel(status: ApiMmaFight["status"]): string {
  if (typeof status === "string") return status;
  return status?.short ?? status?.long ?? "";
}

function mapFightStatus(status: string): FixtureStatus {
  const normalizedStatus = status.trim().toLowerCase();
  if (["ns", "tbd", "scheduled", "upcoming", "not started"].some((value) => normalizedStatus.includes(value))) {
    return "scheduled";
  }
  if (["live", "in progress", "round"].some((value) => normalizedStatus.includes(value))) return "live";
  if (["ft", "finished", "ended", "final", "complete"].some((value) => normalizedStatus.includes(value))) {
    return "finished";
  }
  if (normalizedStatus.includes("postponed")) return "postponed";
  if (normalizedStatus.includes("cancel")) return "cancelled";
  if (normalizedStatus.includes("abandon")) return "abandoned";
  return "scheduled";
}

function fighterImage(fighter: ApiMmaFighter): string | undefined {
  return fighter.logo ?? fighter.image ?? fighter.photo ?? undefined;
}

function hasApiErrors(errors: unknown): boolean {
  if (Array.isArray(errors)) return errors.length > 0;
  if (errors && typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isFixture(fixture: Fixture | undefined): fixture is Fixture {
  return Boolean(fixture);
}
