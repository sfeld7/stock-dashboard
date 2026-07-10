const { httpsGet, FINNHUB_KEY } = require('./_lib/helpers');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_ANALYST_TICKERS = 25;
const ANALYST_BATCH_SIZE  = 8;
const RATINGS_TTL_MS      = 12 * 60 * 60 * 1000; // analyst trends only update ~monthly

// Persists across warm invocations within the same serverless instance
const ratingsCache = new Map(); // ticker -> { data, ts }

const SYSTEM_PROMPT = `You are a portfolio analyst embedded in a personal stock dashboard.
You'll be given a JSON snapshot of the user's current holdings (tickers, shares, market
values, weights, cost basis, gain/loss, day change) and cash/fixed-income positions, an
analystRatings object keyed by ticker (aggregated Wall Street analyst buy/hold/sell counts
for the most recent month, from Finnhub), and a question from the user.

Answer directly and concisely using the data provided. Reference specific tickers, dollar
amounts, and percentages from the snapshot to back up your points. If the question asks
about concentration risk, call out any position or sector over roughly 15-20% of the
portfolio. If the question asks for an opinion or take on a specific name, summarize the
analyst consensus from analystRatings (e.g. "22 buy vs 2 sell") if that ticker is present -
this is an aggregated ratings count, not a written research report, so describe it as
"analyst consensus" rather than implying a single report or source. If data needed to
answer isn't in the snapshot or analystRatings, say so plainly instead of guessing. End
with a one-line reminder that this isn't financial advice only if the question calls for a
recommendation or opinion, not for purely factual lookups.

Keep the answer under 200 words unless the question requires a breakdown or list.`;

async function fetchAnalystRatings(tickers) {
  const ratings = {};
  const now     = Date.now();

  const toFetch = tickers.filter(t => {
    const cached = ratingsCache.get(t);
    if (cached && now - cached.ts < RATINGS_TTL_MS) { ratings[t] = cached.data; return false; }
    return true;
  });

  for (let i = 0; i < toFetch.length; i += ANALYST_BATCH_SIZE) {
    const batch   = toFetch.slice(i, i + ANALYST_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(ticker =>
      httpsGet(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`)
    ));
    results.forEach((r, j) => {
      const ticker = batch[j];
      if (r.status !== 'fulfilled') return;
      try {
        const trend = JSON.parse(r.value.body);
        if (Array.isArray(trend) && trend.length) {
          const { period, strongBuy, buy, hold, sell, strongSell } = trend[0];
          const data = { period, strongBuy, buy, hold, sell, strongSell };
          ratings[ticker] = data;
          ratingsCache.set(ticker, { data, ts: now });
        }
      } catch { /* skip tickers with no usable data */ }
    });
    if (i + ANALYST_BATCH_SIZE < toFetch.length) await new Promise(r => setTimeout(r, 400));
  }
  return ratings;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!ANTHROPIC_KEY) {
    res.status(500).json({ ok: false, error: 'Ask feature is not configured (missing ANTHROPIC_API_KEY).' });
    return;
  }

  const { question, snapshot } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ ok: false, error: 'No question provided' });
    return;
  }
  if (!snapshot || !Array.isArray(snapshot.holdings)) {
    res.status(400).json({ ok: false, error: 'No portfolio snapshot provided' });
    return;
  }

  const trimmedQuestion = question.trim().slice(0, 300);

  try {
    const tickers = [...new Set(snapshot.holdings.map(h => h.ticker).filter(Boolean))]
      .slice(0, MAX_ANALYST_TICKERS);
    const analystRatings = FINNHUB_KEY ? await fetchAnalystRatings(tickers) : {};

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-5',
        max_tokens: 800,
        thinking:   { type: 'disabled' },
        system:     SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Portfolio snapshot (JSON):\n${JSON.stringify(snapshot)}\n\n` +
              `analystRatings (JSON, keyed by ticker):\n${JSON.stringify(analystRatings)}\n\n` +
              `Question: ${trimmedQuestion}`,
          },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ ok: false, error: data?.error?.message || `Anthropic API error (${r.status})` });
      return;
    }

    const answer = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();
    res.status(200).json({ ok: true, answer: answer || 'No answer returned.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
