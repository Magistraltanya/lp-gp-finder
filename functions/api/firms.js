import { ensureTable } from './_ensureTable.js';

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
      contacts : JSON.parse(r.contacts_json || '[]'),
      recentNews: JSON.parse(r.news_json || '[]'),
      investmentPhilosophy: r.philosophy,
      assetsUnderManagement: r.aum,
      typicalCheckSize: r.check_size,
    }));
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }

  // POST logic remains unchanged
  if (request.method === 'POST') {
    // ... your existing POST logic ...
  }
  
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}
