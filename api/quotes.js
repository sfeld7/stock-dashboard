const { httpsGet, FINNHUB_KEY } = require('./_lib/helpers');

// Persists across warm invocations within the same serverless instance
const nameCache = {};

async function fetchName(ticker) {
  if (nameCache[ticker]) return nameCache[ticker];
  try {
    const r = await httpsGet(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`);
    const p = JSON.parse(r.body);
    nameCache[ticker] = p.name || ticker;
  } catch {
    nameCache[ticker] = ticker;
  }
  return nameCache[ticker];
}

async function fetchOneTicker(ticker) {
  const [, r] = await Promise.all([
    fetchName(ticker),
    httpsGet(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`),
  ]);
  const q = JSON.parse(r.body);
  if (q.error) throw new Error(q.error);
  if (!q.c)    throw new Error('No price data');
  return {
    symbol:    ticker,
    shortName: nameCache[ticker] || ticker,
    price:     q.c,
    change:    q.d,
    changePct: q.dp,
    open:      q.o,
    high:      q.h,
    low:       q.l,
    prevClose: q.pc,
  };
}

module.exports = async (req, res) => {
  const url     = new URL(req.url, `https://${req.headers.host}`);
  const tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean);
  if (!tickers.length) return res.status(400).json({ ok: false, error: 'No tickers' });

  const quotes = {};
  const BATCH  = 10;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch   = tickers.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(fetchOneTicker));
    results.forEach((r, j) => {
      const t = batch[j];
      quotes[t] = r.status === 'fulfilled' ? r.value : { symbol: t, error: r.reason.message };
    });
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 400));
  }

  res.status(200).json({ ok: true, quotes });
};
