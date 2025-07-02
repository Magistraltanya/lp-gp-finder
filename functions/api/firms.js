/**
 *  GET  /api/firms          → list rows
 *  POST /api/firms          → bulk upload   body = JSON array [{ …, contacts:[…] }]
 *
 *  NOTE ▸ we are **not** streaming any more – the plain body parser is fast
 *         and avoids the Buffer-undefined crash you just saw.
 */
export async function onRequest({ request, env }) {
  const { DB } = env;

  /* ─────── make sure the table exists (idempotent) ─────── */
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS firms(
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      website             TEXT UNIQUE,
      firm_name           TEXT,
      entity_type         TEXT,
      sub_type            TEXT,
      address             TEXT,
      country             TEXT,
      company_linkedin    TEXT,
      about               TEXT,
      investment_strategy TEXT,
      sector              TEXT,
      sector_details      TEXT,
      stage               TEXT,
      source              TEXT,
      validated           INTEGER DEFAULT 0,
      contacts_json       TEXT DEFAULT '[]',
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  /* ---------- GET  → list everything ---------- */
  if (request.method === 'GET') {
    const rs  = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || '[]') }));
    return json(out);
  }

  /* ---------- POST → Excel upload (already JSON on the FE) ---------- */
  if (request.method === 'POST') {
    let arr;
    try {
      arr = await request.json();               // body is small; OK to buffer
      if (!Array.isArray(arr) || !arr.length) throw 0;
    } catch { return json({ error: 'Body must be a non-empty JSON array' }, 400); }

    const ins = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const r of arr) {
      const key = (r.website || r.firmName || '').toLowerCase();
      if (!key) continue;                       // skip row with no unique key

      try {
        const res = await ins.bind(
          r.website || '',           r.firmName || '',
          r.entityType || '',        r.subType || '',
          r.address || '',           r.country || '',
          r.companyLinkedIn || '',   r.about || '',
          r.investmentStrategy || '', r.sector || '',
          r.sectorDetails || '',     r.stage || '',
          JSON.stringify(r.contacts || [])
        ).run();

        if (res.meta.changes)
          inserted.push({ id: res.meta.last_row_id, source: 'Upload', validated: true, ...r });

      } catch (e) { console.error('DB insert skipped row:', e); }
    }

    return json({ inserted });
  }

  return json({ error: 'Method not allowed' }, 405);
}

/* helper */
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
