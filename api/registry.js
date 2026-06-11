/**
 * ClientIQ — corporate registry verification
 * POST /api/registry  { name: "Acme Corp" }
 *
 * Checks whether the entity exists in official corporate registries:
 *   - SEC EDGAR entity search (US filers, incl. private Form D filers) — no key
 *   - UK Companies House — activates when COMPANIES_HOUSE_API_KEY is set
 *
 * Returns matches as leads for analyst review. An absent registration is a
 * signal, not proof of nonexistence (state-level US registries not covered).
 */

const UA = 'ClientIQ registry verification (contact: parispgrant@gmail.com)';

async function searchEdgar(name) {
  const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits?.hits || []).slice(0, 5).map(h => ({
    name: h._source?.entity || '',
    id: `CIK ${h._id}`,
    detail: h._source?.tickers ? `ticker ${h._source.tickers}` : 'SEC filer',
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${h._id}&type=&dateb=&owner=include&count=10`,
  })).filter(m => m.name);
}

async function searchCompaniesHouse(name, apiKey) {
  const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}&items_per_page=5`;
  const res = await fetch(url, {
    headers: {
      authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
      'user-agent': UA,
    },
  });
  if (!res.ok) throw new Error(`Companies House HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(c => ({
    name: c.title || '',
    id: c.company_number ? `No. ${c.company_number}` : '',
    detail: [c.company_status, c.date_of_creation ? `inc. ${c.date_of_creation}` : '']
      .filter(Boolean).join(' · '),
    url: c.links?.self ? `https://find-and-update.company-information.service.gov.uk${c.links.self}` : '',
  })).filter(m => m.name);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: { message: 'Provide name to verify' } });

  const chKey = process.env.COMPANIES_HOUSE_API_KEY;
  const tasks = [
    { id: 'sec_edgar', label: 'SEC EDGAR', authority: 'US SEC', run: () => searchEdgar(name) },
    chKey
      ? { id: 'uk_ch', label: 'UK Companies House', authority: 'UK Gov', run: () => searchCompaniesHouse(name, chKey) }
      : { id: 'uk_ch', label: 'UK Companies House', authority: 'UK Gov', run: null },
  ];

  const sources = await Promise.all(tasks.map(async t => {
    if (!t.run) return { id: t.id, label: t.label, authority: t.authority, status: 'unconfigured', matches: [] };
    try {
      return { id: t.id, label: t.label, authority: t.authority, status: 'ok', matches: await t.run() };
    } catch (err) {
      console.error('[registry]', t.id, err.message);
      return { id: t.id, label: t.label, authority: t.authority, status: 'error', error: err.message, matches: [] };
    }
  }));

  return res.status(200).json({ checkedAt: new Date().toISOString(), name, sources });
}
