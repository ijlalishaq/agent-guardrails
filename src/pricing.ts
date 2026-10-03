import type { Usage } from "./models/types.js";

interface Price {
  input: number;
  output: number;
  /** Cache reads. Defaults to a tenth of the input price. */
  cacheRead?: number;
  /** Cache writes (5 minute TTL). Defaults to 1.25x the input price. */
  cacheWrite?: number;
}

/** USD per million tokens. Anthropic first-party API prices as of September 2026. */
const PRICES: Record<string, Price> = {
  "anthropic:claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "anthropic:claude-sonnet-5": { input: 2, output: 10 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  scripted: { input: 0, output: 0 },
};

/** Add or override a price, e.g. for an OpenAI model you're testing. */
export function setPrice(model: string, price: Price): void {
  PRICES[model] = price;
}

/** Cost of one call in USD, or null when the model has no known price. */
export function costOf(model: string, usage: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  const write = p.cacheWrite ?? p.input * 1.25;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * read +
      (usage.cacheWriteTokens ?? 0) * write) /
    1_000_000
  );
}
