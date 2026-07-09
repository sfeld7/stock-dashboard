const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are a portfolio analyst embedded in a personal stock dashboard.
You'll be given a JSON snapshot of the user's current holdings (tickers, shares, market
values, weights, cost basis, gain/loss, day change) and cash/fixed-income positions, plus
a question from the user.

Answer directly and concisely using the data provided. Reference specific tickers, dollar
amounts, and percentages from the snapshot to back up your points. If the question asks
about concentration risk, call out any position or sector over roughly 15-20% of the
portfolio. If data needed to answer isn't in the snapshot, say so plainly instead of
guessing. End with a one-line reminder that this isn't financial advice only if the
question calls for a recommendation or opinion, not for purely factual lookups.

Keep the answer under 200 words unless the question requires a breakdown or list.`;

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
            content: `Portfolio snapshot (JSON):\n${JSON.stringify(snapshot)}\n\nQuestion: ${trimmedQuestion}`,
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
