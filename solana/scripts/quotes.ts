// Stock quotes and US market hours from Yahoo Finance's public chart endpoint (no API key).
// Devnet only: an unofficial source. Relayer nodes sign what they read here; the program checks the signatures.

export interface Quote {
  ticker: string;
  price: number;
  /** Unix seconds of the last trade. */
  marketTime: number;
  /** Whether `now` falls inside today's regular session (09:30–16:00 ET, holidays respected). */
  regularOpen: boolean;
}

interface ChartMeta {
  regularMarketPrice: number;
  regularMarketTime: number;
  currentTradingPeriod?: { regular?: { start: number; end: number } };
}

export async function fetchQuote(ticker: string, now = Date.now() / 1000): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const body = (await res.json()) as { chart: { result?: { meta: ChartMeta }[]; error?: unknown } };
  const meta = body.chart.result?.[0]?.meta;
  if (!meta || !(meta.regularMarketPrice > 0)) throw new Error(`${ticker}: no price in response`);
  const period = meta.currentTradingPeriod?.regular;
  return {
    ticker,
    price: meta.regularMarketPrice,
    marketTime: meta.regularMarketTime,
    regularOpen: !!period && now >= period.start && now < period.end,
  };
}
