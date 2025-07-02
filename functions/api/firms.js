import { ensureTable } from './_ensureTable.js';

/**
 *  GET  /api/firms         → all rows
 *  POST /api/firms         → bulk upload, body = JSON array
 */
export async function onRequest({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  /* ─────────── GET ─────────── */
  if (request.method === 'GET') {
    const rs  = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || '[]') }));
    return json(out);
  }

  /* ─────────── POST (stream) ───────────
     The body can be >10 MB when the Excel → JSON array is large.
     We therefore read the request as text in small chunks and parse at the end.
  */
  if (request.method === 'POST') {
    let raw = '';
    const reader = request.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      if (raw.length > 5_000_000)       // ~5 MB guard: enough for ~40 k rows
        return json({ error:'Upload too large – please split the file' }, 413);
    }

    let list;
    try { list = JSON.parse(raw); if (!Array.isArray(list) || !list.length) throw 0; }
    catch { return json({ error:'Body must be a non-empty JSON array' }, 400); }

    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const r of list) {
      const key = (r.website || r.firmName || '').toLowerCase();
      if (!key) continue;

      try {
        const res = await stmt.bind(
          r.website || '',           r.firmName || '',
          r.entityType || '',        r.subType || '',
          r.address || '',           r.country || '',
          r.companyLinkedIn || '',   r.about || '',
          r.investmentStrategy || '', r.sector || '',
          r.sectorDetails || '',     r.stage || '',
          JSON.stringify(r.contacts || [])
        ).run();

        if (res.meta.changes)
          inserted.push({ id: res.meta.last_row_id, source:'Upload', validated:true, ...r });

      } catch (e) { console.error('Insert skipped row:', e); }
    }

    return json({ inserted });
  }

  return json({ error:'Method not allowed' }, 405);
}

/* helper */
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
