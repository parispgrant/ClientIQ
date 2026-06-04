/**
 * ClientIQ — Anthropic API proxy
 * Node.js Serverless Function (NOT Edge) so vercel.json maxDuration: 60
 * is respected — a full 60s budget for the Anthropic response.
 *
 * When the request body has `stream: true`, the upstream Server-Sent-Events
 * response is piped straight through to the browser. Because bytes flow
 * continuously, Vercel never buffers the whole reply and never returns a 504
 * gateway timeout on long generations. Requests without `stream` (e.g. the
 * small per-section regenerate calls) keep the simple buffered JSON path.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
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

  const wantStream = req.body && req.body.stream === true;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(req.body),
    });

    // Errors come back as JSON even when streaming was requested — forward as-is.
    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).setHeader('Content-Type', 'application/json');
      return res.end(errText);
    }

    if (!wantStream) {
      const data = await upstream.json();
      return res.status(upstream.status).json(data);
    }

    // ── Stream the SSE bytes straight through ──────────────────────────────
    res.status(200);
    res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection',    'keep-alive');

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    return res.end();
  } catch (err) {
    console.error('[ClientIQ proxy]', err.message);
    if (!res.headersSent) {
      return res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
    }
    return res.end();
  }
}
