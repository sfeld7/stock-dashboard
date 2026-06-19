const { httpsGet } = require('./_lib/helpers');

module.exports = async (req, res) => {
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const ticker = url.searchParams.get('ticker');
  if (!ticker) return res.status(400).json({ ok: false, error: 'No ticker' });

  try {
    const r    = await httpsGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=1d`,
      { Accept: 'application/json' }
    );
    const data   = JSON.parse(r.body);
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp?.length) return res.status(200).json({ ok: false, error: 'No candles' });

    const q      = result.indicators.quote[0];
    const closes = q.close.filter(c => c != null);
    const opens  = q.open.filter(o => o != null);
    if (!closes.length) return res.status(200).json({ ok: false, error: 'No candles' });

    res.status(200).json({ ok: true, closes, opens });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
