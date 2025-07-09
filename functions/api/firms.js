import { ensureTable } from './_ensureTable.js';

/**
 * Normalizes a URL string to a canonical form for de-duplication.
 */
function normalizeUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return '';
  try {
    let fullUrl = urlString.trim();
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://' + fullUrl;
    }
    const url = new URL(fullUrl);
    let hostname = url.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    let path = url.pathname;
    if (path === '/') path = '';
    else if (path.endsWith('/')) path = path.slice(0, -1);
    
    return (hostname + path + url.search).toLowerCase();
  } catch (e) {
    return urlString.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }
}

export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  if (request.method === 'GET') {
    const rs = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || '[]') }));
    return json(out);
  }

  if (request.method === 'POST') {
    // --- (File reading and parsing logic is unchanged) ---
    let raw = '';
    const rdr = request.body.getReader();
    while (true) { const { value, done } = await rdr.read(); if (done) break; raw += new TextDecoder().decode(value); if (raw.length > 10_000_000) return json({ error : 'File too large – please split it.' }, 413); }
    let rows;
    try { rows = JSON.parse(raw); if (!Array.isArray(rows) || !rows.length) throw 0; } catch { return json({ error : 'Body must be a non-empty JSON array.' }, 400); }

    const buckets = new Map();
    for (const r of rows) {
      const originalWebsite = (r.website || '').trim();
      const firmName = (r.firmName || '').trim();
      const key = normalizeUrl(originalWebsite) || firmName.toLowerCase();
      if (!key) continue;

      if (!buckets.has(key)) {
        buckets.set(key, {
          data: { website: originalWebsite, firm_name: firmName, entity_type: r.entityType || '', sub_type: r.subType || '', address: r.address || '', country: r.country || '', company_linkedin: r.companyLinkedIn || '', about: r.about || '', investment_strategy: r.investmentStrategy || '', sector: r.sector || '', sector_details: r.sectorDetails || '', stage: r.stage || '' },
          contacts : []
        });
      }
      const hasContact = r.contactName || r.designation || r.email || r.linkedIn || r.contactNumber;
      if (hasContact) {
        buckets.get(key).contacts.push({ contactName: r.contactName || '', designation: r.designation || '', email: r.email || '', linkedIn: r.linkedIn || '', contactNumber: r.contactNumber || '' });
      }
    }

    if (!buckets.size) return json({ inserted : [] });

    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const bucket of buckets.values()) {
      const d = bucket.data;
      const firmName = d.firm_name;

      // De-dupe Step 1: Skip if firm name is missing or already exists
      if (!firmName) continue;
      const existing = await DB.prepare("SELECT id FROM firms WHERE firm_name = ?1").bind(firmName).first();
      if (existing) continue;

      const normalizedWebsite = normalizeUrl(d.website);

      // De-dupe Step 2: INSERT OR IGNORE handles website collisions
      const res = await stmt.bind(
        normalizedWebsite, firmName, d.entity_type, d.sub_type, d.address, d.country,
        d.company_linkedin, d.about, d.investment_strategy,
        d.sector, d.sector_details, d.stage,
        JSON.stringify(bucket.contacts)
      ).run();

      if (res.meta.changes) {
        inserted.push({
          id: res.meta.last_row_id, source: 'Upload', validated: true, contacts: bucket.contacts,
          firmName: d.firm_name, entityType: d.entity_type, subType: d.sub_type,
          companyLinkedIn: d.company_linkedin, investmentStrategy: d.investment_strategy,
          sectorDetails: d.sector_details, website: d.website, address: d.address,
          country: d.country, about: d.about, sector: d.sector, stage: d.stage
        });
      }
    }

    return json({ inserted });
  }

  return json({ error : 'Method not allowed' }, 405);
}

function json (data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type' : 'application/json' } });
}
