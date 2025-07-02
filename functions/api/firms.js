/*  GET  /api/firms           → list
 *  POST /api/firms           → bulk upload (streamed)
 */
import { ensureTable } from './_ensureTable.js';

export async function onRequest({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  /* ---------- list ---------- */
  if (request.method === 'GET') {
    const rs = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    return json(rs.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || '[]') })));
  }

  /* ---------- upload (streaming) ---------- */
  if (request.method === 'POST') {
    const reader = request.body?.getReader?.();
    if (!reader) return json({ error: 'stream expected' }, 400);

    // assemble the body safely (handles large XLSX → JSON)
    const chunks = [];
    let done, value;
    while ({ done, value } = await reader.read(), !done) chunks.push(value);
    const body = new TextDecoder().decode(Buffer.concat(chunks));

    let arr;
    try { arr = JSON.parse(body); } catch { return json({ error: 'body must be JSON array' }, 400); }
    if (!Array.isArray(arr) || !arr.length) return json({ error: 'array expected' }, 400);

    const ins = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const r of arr) {
      const uniq = (r.website || r.firmName || '').toLowerCase();
      if (!uniq) continue;                           // skip rows with no key
      try {
        const res = await ins.bind(
          r.website || '', r.firmName || '', r.entityType || '', r.subType || '',
          r.address || '', r.country || '', r.companyLinkedIn || '',
          r.about || '', r.investmentStrategy || '', r.sector || '',
          r.sectorDetails || '', r.stage || '', JSON.stringify(r.contacts || [])
        ).run();
        if (res.meta.changes)
          inserted.push({ id: res.meta.last_row_id, source: 'Upload', validated: true, ...r });
      } catch { /* duplicate website or other error → ignore row */ }
    }
    return json({ inserted });
  }

  return json({ error: 'Method not allowed' }, 405);
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
