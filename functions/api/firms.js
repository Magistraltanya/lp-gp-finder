import { ensureTable } from './_ensureTable.js';

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    { status, headers: { 'content-type' : 'application/json' } }
  );
}

export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  if (request.method === 'GET') {
    const rs = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({
      ...r,
      contacts: JSON.parse(r.contacts_json || '[]')
    }));
    return json(out);
  }

  if (request.method === 'POST') {
    let raw = '';
    const rdr = request.body.getReader();
    while (true) {
      const { value, done } = await rdr.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      if (raw.length > 10_000_000)
        return json({ error : 'File too large – please split it.' }, 413);
    }

    let rows;
    try {
      rows = JSON.parse(raw);
      if (!Array.isArray(rows) || !rows.length) throw 0;
    }
    catch {
      return json({ error : 'Body must be a non-empty JSON array.' }, 400);
    }

    const buckets = new Map();
    for (const r of rows) {
      const key = (r.website || r.firmName || '').toLowerCase().trim();
      if (!key) continue;

      if (!buckets.has(key)) {
        buckets.set(key, {
          data: {
            website: r.website || '',
            firm_name: r.firmName || '',
            entity_type: r.entityType || '',
            sub_type: r.subType || '',
            address: r.address || '',
            country: r.country || '',
            company_linkedin: r.companyLinkedIn || '',
            about: r.about || '',
            investment_strategy: r.investmentStrategy || '',
            sector: r.sector || '',
            sector_details: r.sectorDetails || '',
            stage: r.stage || ''
          },
          contacts : []
        });
      }

      const hasContact = r.contactName || r.designation || r.email || r.linkedIn || r.contactNumber;
      if (hasContact) {
        buckets.get(key).contacts.push({
          contactName: r.contactName || '',
          designation: r.designation || '',
          email: r.email || '',
          linkedIn: r.linkedIn || '',
          contactNumber: r.contactNumber || ''
        });
      }
    }

    if (!buckets.size) return json({ inserted : [] });

    const stmt = await DB.prepare(`INSERT OR IGNORE INTO firms (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy, sector,sector_details,stage,source,validated,contacts_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)`);
    const inserted = [];

    for (const bucket of buckets.values()) {
      const d = bucket.data;
      const res = await stmt.bind(
        d.website, d.firm_name, d.entity_type, d.sub_type, d.address, d.country,
        d.company_linkedin, d.about, d.investment_strategy,
        d.sector, d.sector_details, d.stage,
        JSON.stringify(bucket.contacts)
      ).run();

      if (res.meta.changes) {
        inserted.push({
          id: res.meta.last_row_id,
          source: 'Upload',
          validated: true,
          contacts: bucket.contacts,
          firmName: d.firm_name,
          entityType: d.entity_type,
          subType: d.sub_type,
          companyLinkedIn: d.company_linkedin,
          investmentStrategy: d.investment_strategy,
          sectorDetails: d.sector_details,
          ...d
        });
      }
    }
    return json({ inserted });
  }

  return json({ error : 'Method not allowed' }, 405);
}
