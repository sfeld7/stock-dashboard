const { httpsGet } = require('./_lib/helpers');

module.exports = async (req, res) => {
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const ticker = url.searchParams.get('ticker');
  if (!ticker) return res.status(400).json({ ok: false, error: 'No ticker' });

  try {
    const r = await httpsGet(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
    if (r.status === 429) return res.status(200).json({ ok: false, error: 'Rate limited' });
    if (r.status !== 200) return res.status(200).json({ ok: false, error: `HTTP ${r.status}` });

    const data     = JSON.parse(r.body);
    const messages = data.messages || [];
    let bull = 0, bear = 0, total = 0;
    messages.forEach(m => {
      const s = m.entities?.sentiment?.basic;
      if (s === 'Bullish') { bull++; total++; }
      else if (s === 'Bearish') { bear++; total++; }
    });

    const score    = total ? Math.round((bull / total) * 100) : null;
    const snippets = messages.slice(0, 3).map(m => m.body?.slice(0, 80)).filter(Boolean);
    res.status(200).json({ ok: true, bull, bear, total, score, msgCount: messages.length, snippets });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
