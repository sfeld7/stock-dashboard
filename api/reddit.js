const { httpsGet, scoreText } = require('./_lib/helpers');

const redditCache = {};

module.exports = async (req, res) => {
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const ticker = url.searchParams.get('ticker');
  if (!ticker) return res.status(400).json({ ok: false, error: 'No ticker' });

  const cached = redditCache[ticker];
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    return res.status(200).json({ ok: true, ...cached.data });
  }

  const subs    = ['wallstreetbets', 'stocks', 'investing'];
  const query   = encodeURIComponent(`$${ticker} OR ${ticker}`);
  const headers = { 'User-Agent': 'StockDashboard/1.0 (personal use)' };

  let totalBull = 0, totalBear = 0, posts = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    let r;
    try {
      r = await httpsGet(
        `https://www.reddit.com/r/${sub}/search.json?q=${query}&restrict_sr=on&sort=new&limit=15&t=week`,
        headers
      );
    } catch { continue; }
    if (r.status === 429) continue;
    let data;
    try { data = JSON.parse(r.body); } catch { continue; }
    const children = data?.data?.children || [];
    children.forEach(({ data: p }) => {
      const text  = `${p.title || ''} ${p.selftext || ''}`;
      const score = scoreText(text);
      totalBull += score.bull;
      totalBear += score.bear;
      if (p.title && (score.bull > 0 || score.bear > 0 || p.ups > 10)) {
        posts.push({
          title:     p.title,
          sub,
          ups:       p.ups,
          url:       `https://reddit.com${p.permalink}`,
          created:   p.created_utc,
          sentiment: score.bull > score.bear ? 'bull' : score.bear > score.bull ? 'bear' : 'neutral',
          bull:      score.bull,
          bear:      score.bear,
        });
      }
    });
    if (i < subs.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  const total    = totalBull + totalBear;
  const score    = total > 0 ? Math.round((totalBull / total) * 100) : null;
  const topPosts = posts.sort((a, b) => b.ups - a.ups).slice(0, 8);
  const result   = { bull: totalBull, bear: totalBear, total, score, posts: topPosts };

  redditCache[ticker] = { ts: Date.now(), data: result };
  res.status(200).json({ ok: true, ...result });
};
