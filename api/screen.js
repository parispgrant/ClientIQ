/**
 * ClientIQ — live sanctions screening
 * POST /api/screen  { names: ["Acme Corp", ...] }
 *
 * Screens names against live government sanctions data:
 *   - OFAC SDN list (+ ALT aliases)
 *   - OFAC Consolidated (non-SDN) list
 *   - UK OFSI Consolidated list
 *
 * Lists are fetched from official sources and cached in module scope for
 * 12 hours, so warm invocations skip the ~25MB download. Matching is fuzzy:
 * normalized exact, token overlap, and edit distance, scored 0–100.
 * Results are drafts for a human analyst — never a determination.
 */

const SOURCES = [
  {
    id: 'ofac_sdn',
    label: 'OFAC SDN',
    authority: 'US Treasury',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
    parse: parseOfacCsv,
  },
  {
    id: 'ofac_cons',
    label: 'OFAC Consolidated (Non-SDN)',
    authority: 'US Treasury',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV',
    parse: parseOfacCsv,
  },
  {
    id: 'uk_ofsi',
    label: 'UK OFSI Consolidated',
    authority: 'UK HM Treasury',
    url: 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv',
    parse: parseUkCsv,
  },
  {
    id: 'un_consolidated',
    label: 'UN Security Council Consolidated',
    authority: 'United Nations',
    url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
    parse: parseUnXml,
  },
  // EU FSF list intentionally absent: the published file is ~24MB and takes
  // ~50s to download, which cannot fit a cold serverless invocation. Needs an
  // offline slimming pipeline (planned v4).
];

const OFAC_ALT_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache = { fetchedAt: 0, lists: null };

// ── CSV parsing ───────────────────────────────────────────────────────────────

// Minimal RFC-4180 parser: handles quoted fields with embedded commas,
// escaped quotes ("") and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const nul = v => !v || v.trim() === '-0-' ? '' : v.trim();

// OFAC SDN / CONS format: ent_num, name, type, program(s), ..., remarks
function parseOfacCsv(text) {
  return parseCsv(text)
    .filter(r => r.length >= 4)
    .map(r => ({
      uid: nul(r[0]),
      name: nul(r[1]),
      type: nul(r[2]) || 'entity',
      program: nul(r[3]).replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter(e => e.name);
}

// UK OFSI 2022 format: line 1 is "Last Updated,<date>", line 2 headers.
// Name 6 (col 0) is surname/entity name; Name 1–5 (cols 1–5) given names.
function parseUkCsv(text) {
  const rows = parseCsv(text);
  const header = rows[1] || [];
  const col = label => header.indexOf(label);
  const iGroupType = col('Group Type'), iRegime = col('Regime'), iGroupId = col('Group ID');
  return rows.slice(2)
    .map(r => {
      const name = [r[1], r[2], r[3], r[4], r[5], r[0]]
        .map(v => (v || '').trim()).filter(Boolean).join(' ');
      return {
        uid: (r[iGroupId] || '').trim(),
        name,
        type: ((r[iGroupType] || '').trim() || 'entity').toLowerCase(),
        program: (r[iRegime] || '').trim(),
      };
    })
    .filter(e => e.name);
}

// UN Security Council consolidated XML: <INDIVIDUAL> blocks carry the name in
// FIRST_NAME..FOURTH_NAME; <ENTITY> blocks carry it in FIRST_NAME. Both can
// have *_ALIAS children with ALIAS_NAME. Regex-per-block keeps us dependency-free.
function parseUnXml(text) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
    return m ? m[1].trim() : '';
  };
  const entries = [];
  const blocks = text.match(/<INDIVIDUAL>[\s\S]*?<\/INDIVIDUAL>|<ENTITY>[\s\S]*?<\/ENTITY>/g) || [];
  for (const block of blocks) {
    const isIndividual = block.startsWith('<INDIVIDUAL>');
    const uid = tag(block, 'DATAID');
    const name = [tag(block, 'FIRST_NAME'), tag(block, 'SECOND_NAME'), tag(block, 'THIRD_NAME'), tag(block, 'FOURTH_NAME')]
      .filter(Boolean).join(' ');
    if (!name) continue;
    const entry = { uid, name, type: isIndividual ? 'individual' : 'entity', program: tag(block, 'UN_LIST_TYPE') };
    entries.push(entry);
    const aliases = block.match(/<ALIAS_NAME>([^<]*)<\/ALIAS_NAME>/g) || [];
    for (const a of aliases) {
      const aliasName = a.replace(/<\/?ALIAS_NAME>/g, '').trim();
      if (aliasName) entries.push({ ...entry, name: aliasName, aliasOf: entry.name });
    }
  }
  return entries;
}

function parseOfacAltCsv(text) {
  // ent_num, alt_num, alt_type, alt_name, remarks
  return parseCsv(text)
    .filter(r => r.length >= 4 && nul(r[3]))
    .map(r => ({ uid: nul(r[0]), name: nul(r[3]) }));
}

// ── List loading + cache ──────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'ClientIQ-screening/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function loadLists() {
  if (cache.lists && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.lists;

  const settled = await Promise.allSettled([
    ...SOURCES.map(s => fetchText(s.url)),
    fetchText(OFAC_ALT_URL),
  ]);

  const lists = SOURCES.map((s, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled') {
      console.error('[screen] list fetch failed:', s.id, r.reason?.message);
      return { ...s, entries: [], error: 'source unavailable' };
    }
    return { ...s, entries: s.parse(r.value) };
  });

  // Merge OFAC aliases into the SDN list as additional screenable names.
  const altRes = settled[settled.length - 1];
  if (altRes.status === 'fulfilled') {
    const sdn = lists.find(l => l.id === 'ofac_sdn');
    if (sdn && sdn.entries.length) {
      const byUid = new Map(sdn.entries.map(e => [e.uid, e]));
      for (const alt of parseOfacAltCsv(altRes.value)) {
        const primary = byUid.get(alt.uid);
        if (primary) sdn.entries.push({ ...primary, name: alt.name, aliasOf: primary.name });
      }
    }
  }

  if (lists.some(l => l.entries.length)) cache = { fetchedAt: Date.now(), lists };
  return lists;
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

const CORP_SUFFIXES = new Set([
  'INC', 'INCORPORATED', 'LLC', 'LTD', 'LIMITED', 'CORP', 'CORPORATION', 'CO',
  'COMPANY', 'SA', 'SARL', 'PLC', 'GMBH', 'AG', 'BV', 'NV', 'PTE', 'PTY', 'LP', 'LLP',
]);

function normalize(name) {
  return (name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function coreTokens(tokens) {
  const core = tokens.filter(t => !CORP_SUFFIXES.has(t));
  return core.length ? core : tokens;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 10) return 99;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function scoreMatch(queryTokens, entryTokens) {
  if (!queryTokens.length || !entryTokens.length) return 0;
  const q = queryTokens.join(' '), e = entryTokens.join(' ');
  if (q === e) return 100;

  const eSet = new Set(entryTokens);
  const overlap = queryTokens.filter(t => eSet.has(t)).length;
  const union = new Set([...queryTokens, ...entryTokens]).size;
  let score = Math.round((overlap / union) * 100);
  // All query tokens present inside the entry (e.g. "WAGNER" ⊂ "PMC WAGNER")
  if (overlap === queryTokens.length) score = Math.max(score, 85);

  // Edit-distance similarity catches transliteration/spelling variants.
  const maxLen = Math.max(q.length, e.length);
  if (maxLen <= 40) {
    const sim = Math.round((1 - levenshtein(q, e) / maxLen) * 100);
    score = Math.max(score, sim);
  }
  return score;
}

function screenName(rawName, lists, threshold) {
  const queryTokens = coreTokens(normalize(rawName));
  return lists.map(list => {
    const seen = new Map(); // uid -> best match (dedupe alias hits)
    for (const entry of list.entries) {
      const score = scoreMatch(queryTokens, coreTokens(normalize(entry.name)));
      if (score >= threshold) {
        const prev = seen.get(entry.uid);
        if (!prev || score > prev.score) {
          seen.set(entry.uid, {
            name: entry.aliasOf ? `${entry.name} (a.k.a. of ${entry.aliasOf})` : entry.name,
            type: entry.type,
            program: entry.program,
            score,
          });
        }
      }
    }
    const matches = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    return {
      id: list.id,
      label: list.label,
      authority: list.authority,
      entries: list.entries.length,
      error: list.error || null,
      matches,
    };
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const names = (req.body?.names || []).map(n => String(n || '').trim()).filter(Boolean).slice(0, 10);
  if (!names.length) {
    return res.status(400).json({ error: { message: 'Provide names: ["..."] to screen' } });
  }

  try {
    const lists = await loadLists();
    const threshold = 80;
    const results = names.map(name => ({ name, lists: screenName(name, lists, threshold) }));
    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      threshold,
      totalEntries: lists.reduce((s, l) => s + l.entries.length, 0),
      results,
    });
  } catch (err) {
    console.error('[screen]', err);
    return res.status(502).json({ error: { message: `Screening failed: ${err.message}` } });
  }
}

export { parseOfacCsv, parseUkCsv, parseUnXml, parseOfacAltCsv, screenName, scoreMatch, normalize, coreTokens };
