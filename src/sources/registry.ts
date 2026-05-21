import type { MarketDataSource } from "./types.js";

export class SourceRegistry {
  private readonly sources = new Map<string, MarketDataSource>();

  register(source: MarketDataSource): void {
    this.sources.set(source.provider, source);
  }

  get(provider: string): MarketDataSource {
    const source = this.sources.get(provider);
    if (!source) {
      throw new Error(`Unknown market data source: ${provider}`);
    }

    return source;
  }

  listProviders(): string[] {
    return [...this.sources.keys()];
  }
}
