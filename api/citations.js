/**
 * ClientIQ — regulatory citation verification
 * POST /api/citations  { citations: ["31 CFR §1010.230", ...] }
 *
 * Verifies CFR citations against the official eCFR structure API so a
 * hallucinated citation never reaches an analyst unflagged. Each citation
 * comes back as:
 *   verified    — the title/part/section exists in the current eCFR (+ label, url)
 *   not_found   — parsed as a CFR cite but no such part/section exists
 *   unsupported — not a CFR citation (USC, FinCEN guidance, MAS, EU...) — cannot
 *                 be machine-verified yet, flagged for human check
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const titleCache = new Map(); // title number -> { fetchedAt, root }

async function getTitleStructure(title) {
  const hit = titleCache.get(title);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.root;
  const res = await fetch(`https://www.ecfr.gov/api/versioner/v1/structure/current/title-${title}.json`, {
    headers: { 'user-agent': 'ClientIQ citation verification (contact: parispgrant@gmail.com)' },
  });
  if (!res.ok) throw new Error(`eCFR title ${title} -> HTTP ${res.status}`);
  const root = await res.json();
  titleCache.set(title, { fetchedAt: Date.now(), root });
  return root;
}

function findNode(node, type, identifier) {
  if (node.type === type && node.identifier === identifier) return node;
  for (const child of node.children || []) {
    const r = findNode(child, type, identifier);
    if (r) return r;
  }
  return null;
}

const CFR_RE = /(\d{1,2})\s*C\.?F\.?R\.?\s*(?:§+\s*|part\s+|pt\.?\s*)?(\d{1,4})(?:\.(\d{1,4}[a-z]?))?/i;

async function verifyCitation(raw) {
  const citation = String(raw || '').trim();
  if (!citation) return { citation, status: 'unsupported' };

  const m = citation.match(CFR_RE);
  if (!m) return { citation, status: 'unsupported' };

  const [, title, part, section] = m;
  try {
    const root = await getTitleStructure(title);
    if (section) {
      const ident = `${part}.${section}`;
      const node = findNode(root, 'section', ident);
      return node
        ? { citation, status: 'verified', label: node.label, url: `https://www.ecfr.gov/current/title-${title}/section-${ident}` }
        : { citation, status: 'not_found' };
    }
    const node = findNode(root, 'part', part);
    return node
      ? { citation, status: 'verified', label: node.label, url: `https://www.ecfr.gov/current/title-${title}/part-${part}` }
      : { citation, status: 'not_found' };
  } catch (err) {
    console.error('[citations]', citation, err.message);
    return { citation, status: 'error', error: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const citations = [...new Set((req.body?.citations || []).map(c => String(c || '').trim()).filter(Boolean))].slice(0, 20);
  if (!citations.length) {
    return res.status(400).json({ error: { message: 'Provide citations: ["..."] to verify' } });
  }

  const results = await Promise.all(citations.map(verifyCitation));
  return res.status(200).json({ checkedAt: new Date().toISOString(), results });
}

export { verifyCitation, CFR_RE };
