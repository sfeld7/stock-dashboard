const { httpsGet } = require('./_lib/helpers');

const INDICES = [
  { symbol: '^DJI',  label: 'DJIA'    },
  { symbol: '^IXIC', label: 'NASDAQ'  },
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^VIX',  label: 'VIX'     },
];

module.exports = async (req, res) => {
  try {
    const results = await Promise.allSettled(
      INDICES.map(({ symbol }) =>
        httpsGet(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
          { Accept: 'application/json' }
        )
      )
    );

    const data = results.map((r, i) => {
      const { symbol, label } = INDICES[i];
      if (r.status !== 'fulfilled') return { symbol, label, error: true };
      try {
        const d      = JSON.parse(r.value.body);
        const result = d?.chart?.result?.[0];
        if (!result) return { symbol, label, error: true };
        const meta   = result.meta;
        const price  = meta.regularMarketPrice;
        const prev   = meta.chartPreviousClose ?? meta.previousClose;
        const change = price - prev;
        const pct    = prev ? (change / prev) * 100 : 0;
        return { symbol, label, price, change, pct, prev };
      } catch {
        return { symbol, label, error: true };
      }
    });

    res.status(200).json({ ok: true, indices: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
