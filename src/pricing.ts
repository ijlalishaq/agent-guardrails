/** USD per million tokens. Anthropic first-party API prices as of September 2026. */
const PRICES: Record<string, { input: number; output: number }> = {
  "anthropic:claude-fable-5-1": { input: 10, output: 50 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20 },
  "anthropic:claude-sonnet-5": { input: 2, output: 10 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  scripted: { input: 0, output: 0 },
};

/** Add or override a price, e.g. for an OpenAI model you're testing. */
export function setPrice(model: string, input: number, output: number): void {
  PRICES[model] = { input, output };
}

/** Cost of one call in USD, or null when the model has no known price. */
export function costOf(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
