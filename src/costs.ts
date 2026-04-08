type Pricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const PRICING: Record<string, Pricing> = {
  "claude-opus-4-6": { input: 6.15, output: 30.75, cacheWrite: 7.69, cacheRead: 0.61 },
  "claude-opus-4-5": { input: 6.15, output: 30.75, cacheWrite: 7.69, cacheRead: 0.61 },
  "claude-sonnet-4-6": { input: 3.69, output: 18.45, cacheWrite: 4.61, cacheRead: 0.37 },
  "claude-sonnet-4-5": { input: 3.69, output: 18.45, cacheWrite: 4.61, cacheRead: 0.37 },
  "claude-haiku-4-6": { input: 1.23, output: 6.15, cacheWrite: 1.54, cacheRead: 0.12 },
  "claude-haiku-4-5": { input: 1.23, output: 6.15, cacheWrite: 1.54, cacheRead: 0.12 }
};

export function isBillable(model: string | null | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.toLowerCase();
  return normalized.includes("opus") || normalized.includes("sonnet") || normalized.includes("haiku");
}

export function getPricing(model: string | null | undefined): Pricing | null {
  if (!model) {
    return null;
  }
  if (PRICING[model]) {
    return PRICING[model];
  }
  for (const [prefix, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) {
      return pricing;
    }
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) {
    return PRICING["claude-opus-4-6"];
  }
  if (normalized.includes("sonnet")) {
    return PRICING["claude-sonnet-4-6"];
  }
  if (normalized.includes("haiku")) {
    return PRICING["claude-haiku-4-5"];
  }
  return null;
}

export function calcCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  if (!isBillable(model)) {
    return 0;
  }
  const pricing = getPricing(model);
  if (!pricing) {
    return 0;
  }
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000 +
    (cacheReadTokens * pricing.cacheRead) / 1_000_000 +
    (cacheCreationTokens * pricing.cacheWrite) / 1_000_000
  );
}

export function fmt(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

export function fmtCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function fmtCostBig(value: number): string {
  return `$${value.toFixed(2)}`;
}
