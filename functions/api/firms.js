import { ensureTable } from './_ensureTable.js';

// Helper to safely parse JSON from the database
const safeJsonParse = (str, defaultVal = []) => {
  if (!str) return defaultVal;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error('Failed to parse JSON:', str, e);
    return defaultVal;
  }
};

export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  if (request.method === 'GET') {
    const rs  = await DB.prepare(`
      SELECT 
        id, firm_name, entity_type, sub_type, address, country, website, 
        company_linkedin, about, investment_strategy, sector, sector_details, 
        stage, source, validated, contacts_json, 
        philosophy, aum, check_size, news_json 
      FROM firms ORDER BY id DESC
    `).all();
    
    const out = rs.results.map(r => ({
      ...r,
      contacts : safeJsonParse(r.contacts_json),
      recentNews: safeJsonParse(r.news_json),
      investmentPhilosophy: r.philosophy,
      assetsUnderManagement: r.aum,
      typicalCheckSize: r.check_size,
    }));
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }

  if (request.method === 'POST') {
    let raw = '';
    const rdr = request.body.getReader();
    while (true) {
      const { value, done } = await rdr.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      if (raw.length > 10_000_000) return new Response(JSON.stringify({ error : 'File too large – please split it.' }), { status: 413 });
    }

    let firmsToInsert;
    try {
      firmsToInsert = JSON.parse(raw);
      if (!Array.isArray(firmsToInsert) || !firmsToInsert.length) throw 0;
    } catch {
      return new Response(JSON.stringify({ error : 'Body must be a non-empty JSON array.' }), { status: 400 });
    }

    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const firm of firmsToInsert) {
      const key = (firm.website || firm.firmName || '').toLowerCase().trim();
      if (!key) continue;
      const res = await stmt.bind(
        firm.website || '', firm.firmName || '', firm.entityType || 'Other', firm.subType || 'Other',
        firm.address || '', firm.country || '', firm.companyLinkedIn || '', firm.about || '',
        firm.investmentStrategy || '', firm.sector || 'Sector Agnostic', firm.sectorDetails || '',
        firm.stage || 'Stage Agnostic', JSON.stringify(firm.contacts || [])
      ).run();

      if (res.meta.changes) {
        inserted.push({ id: res.meta.last_row_id, source: 'Upload', validated: true, contacts: firm.contacts || [], ...firm });
      }
    }
    return new Response(JSON.stringify({ inserted }), { headers: { 'content-type': 'application/json' } });
  }
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}
