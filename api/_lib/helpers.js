const https = require('https');

const FINNHUB_KEY = process.env.FINNHUB_KEY || 'd8l9b71r01qut1f9th90d8l9b71r01qut1f9th9g';

function httpsGet(urlStr, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   'GET',
        headers:  { 'User-Agent': 'stock-dashboard/1.0', ...extraHeaders },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

const BULL_WORDS = new Set(['buy','long','calls','call','moon','mooning','bullish','undervalued',
  'upside','strong','beat','beats','upgrade','outperform','breakout','rally','bounce',
  'gains','gain','growth','cheap','opportunity','dip','oversold','squeeze','rip','send']);
const BEAR_WORDS = new Set(['sell','short','puts','put','crash','crashing','bearish','overvalued',
  'downside','weak','miss','misses','downgrade','underperform','dump','drop','dropping',
  'decline','expensive','avoid','risky','bubble','overbought','capitulate','tank','tanking']);

function scoreText(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
  let bull = 0, bear = 0;
  words.forEach(w => {
    if (BULL_WORDS.has(w)) bull++;
    if (BEAR_WORDS.has(w)) bear++;
  });
  return { bull, bear };
}

module.exports = { httpsGet, FINNHUB_KEY, scoreText, BULL_WORDS, BEAR_WORDS };
