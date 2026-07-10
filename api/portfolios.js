const crypto = require('crypto');

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PEPPER   = process.env.PORTFOLIO_SYNC_PEPPER || '';

const MAX_PORTFOLIOS  = 50;
const MIN_PASSCODE_LEN = 4;

function keyFor(passcode) {
  const hash = crypto.createHash('sha256').update(`${PEPPER}:${passcode}`).digest('hex');
  return `portfolios:${hash}`;
}

async function kvCommand(cmd) {
  const r = await fetch(KV_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' },
    body:    JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ ok: false, error: 'Sync is not configured (missing KV credentials).' });
    return;
  }

  const passcode = (req.headers['x-passcode'] || '').trim();
  if (passcode.length < MIN_PASSCODE_LEN) {
    res.status(400).json({ ok: false, error: `Passcode must be at least ${MIN_PASSCODE_LEN} characters.` });
    return;
  }

  const key = keyFor(passcode);

  try {
    if (req.method === 'GET') {
      const raw = await kvCommand(['GET', key]);
      const portfolios = raw ? JSON.parse(raw) : null;
      res.status(200).json({ ok: true, portfolios });
      return;
    }

    if (req.method === 'POST') {
      const { portfolios } = req.body || {};
      if (!Array.isArray(portfolios)) {
        res.status(400).json({ ok: false, error: 'portfolios must be an array' });
        return;
      }
      const trimmed = portfolios.slice(0, MAX_PORTFOLIOS).map(p => ({
        id: String(p.id || ''), name: String(p.name || ''), csv: String(p.csv || ''),
      }));
      await kvCommand(['SET', key, JSON.stringify(trimmed)]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
