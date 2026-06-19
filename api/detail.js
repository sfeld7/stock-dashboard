const { httpsGet, FINNHUB_KEY } = require('./_lib/helpers');

module.exports = async (req, res) => {
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const ticker = url.searchParams.get('ticker');
  const range  = url.searchParams.get('range') || '1D';
  if (!ticker) return res.status(400).json({ ok: false, error: 'No ticker' });

  try {
    const cfg = {
      '1D': { interval: '5m',  yfRange: '1d'  },
      '1W': { interval: '1h',  yfRange: '5d'  },
      '1M': { interval: '1d',  yfRange: '1mo' },
      '3M': { interval: '1d',  yfRange: '3mo' },
      '1Y': { interval: '1wk', yfRange: '1y'  },
    }[range] || { interval: '1d', yfRange: '1mo' };

    const yfUrl    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${cfg.interval}&range=${cfg.yfRange}`;
    const newsFrom = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
    const newsTo   = new Date().toISOString().slice(0, 10);

    const [yfRes, newsRes] = await Promise.all([
      httpsGet(yfUrl, { Accept: 'application/json' }),
      httpsGet(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${newsFrom}&to=${newsTo}&token=${FINNHUB_KEY}`),
    ]);

    const allNews = JSON.parse(newsRes.body);
    const news    = Array.isArray(allNews)
      ? allNews.slice(0, 6).map(n => ({
          headline: n.headline, source: n.source, url: n.url, datetime: n.datetime,
        }))
      : [];

    const yfData = JSON.parse(yfRes.body);
    const result = yfData?.chart?.result?.[0];
    if (!result?.timestamp?.length) return res.status(200).json({ ok: true, candles: null, news });

    const q     = result.indicators.quote[0];
    const valid = result.timestamp
      .map((ts, i) => ({ ts, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
      .filter(p => p.c != null);

    if (valid.length < 2) return res.status(200).json({ ok: true, candles: null, news });

    res.status(200).json({
      ok: true,
      candles: {
        t: valid.map(p => p.ts),
        o: valid.map(p => p.o),
        h: valid.map(p => p.h),
        l: valid.map(p => p.l),
        c: valid.map(p => p.c),
      },
      news,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
