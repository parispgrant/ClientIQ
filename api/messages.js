/**
 * ClientIQ — Anthropic API proxy
 * Vercel serverless function: /api/messages
 *
 * Forwards POST requests to Anthropic's API server-side,
 * bypassing browser CORS restrictions entirely.
 * The user's API key is passed per-request and never stored.
 */
export default async function handler(req, res) {
  // CORS headers (needed if the frontend is ever served from a different origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(400).json({ error: { message: 'Missing x-api-key header' } });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[ClientIQ proxy error]', err);
    return res.status(502).json({
      error: { message: `Proxy error: ${err.message}` }
    });
  }
}
