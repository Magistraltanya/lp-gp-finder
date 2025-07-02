import { ensureTable } from './_ensureTable.js';

/**
 *  GET  /api/firms   – list every row (incl. contacts[])
 *  POST /api/firms   – bulk upload; body = JSON array produced in the browser
 *
 *  Upload logic:
 *    • body is streamed – large XLSX files no longer crash the Worker
 *    • rows are grouped by uniqueKey  (website || firmName)
 *    • first row gives the scalar company fields
 *    • every row can supply one contact  → merged into contacts[]
 *    • a single INSERT-OR-IGNORE per firm keeps the DB unique
 */
export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  /* ───────────── GET ───────────── */
  if (request.method === 'GET') {
    const rs  = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || '[]') }));
    return json(out);
  }

  /* ───────────── POST (bulk upload) ───────────── */
  if (request.method === 'POST') {
    /* 1 ◂ stream the body (≤ 10 MB) into a string ───────── */
    let raw = '';
    const reader = request.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      if (raw.length > 10_000_000)             // 10 MB guard – big enough for ~ 80 k rows
        return json({ error:'Upload too large – please split the file.' }, 413);
    }

    /* 2 ◂ parse & basic validation ─────────────────────── */
    let rows;
    try { rows = JSON.parse(raw); if (!Array.isArray(rows) || !rows.length) throw 0; }
    catch { return json({ error:'Body must be a non-empty JSON array.' }, 400); }

    /* 3 ◂ group rows → company + contacts[] ─────────────── */
    const buckets = new Map();                      // key → { data:{…}, contacts:[] }

    for (const r of rows) {
      const key = (r.website || r.firmName || '').toLowerCase().trim();
      if (!key) continue;                           // skip if nothing unique

      if (!buckets.has(key))
        buckets.set(key, { data: {                  // company scalar fields (first row wins)
          website           : r.website           || '',
          firm_name         : r.firmName          || '',
          entity_type       : r.entityType        || '',
          sub_type          : r.subType           || '',
          address           : r.address           || '',
          country           : r.country           || '',
          company_linkedin  : r.companyLinkedIn   || '',
          about             : r.about             || '',
          investment_strategy: r.investmentStrategy|| '',
          sector            : r.sector            || '',
          sector_details    : r.sectorDetails     || '',
          stage             : r.stage             || ''
        }, contacts: [] });

      /* contact object – include only if at least one field present */
      const hasContact =
        r.contactName || r.designation || r.email || r.linkedIn || r.contactNumber;
      if (hasContact) {
        buckets.get(key).contacts.push({
          contactName : r.contactName   || '',
          designation : r.designation   || '',
          email       : r.email         || '',
          linkedIn    : r.linkedIn      || '',
          contactNumber: r.contactNumber|| ''
        });
      }
    }

    if (!buckets.size) return json({ inserted: [] });

    /* 4 ◂ prepared statement ───────────────────────────── */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];

    /* 5 ◂ write each company once, with aggregated contacts */
    for (const bucket of buckets.values()) {
      const d  = bucket.data;
      const res = await stmt.bind(
        d.website, d.firm_name, d.entity_type, d.sub_type, d.address, d.country,
        d.company_linkedin, d.about, d.investment_strategy,
        d.sector, d.sector_details, d.stage,
        JSON.stringify(bucket.contacts)
      ).run();

      if (res.meta.changes) {
        inserted.push({
          id        : res.meta.last_row_id,
          source    : 'Upload',
          validated : true,
          contacts  : bucket.contacts,
          ...d,                // camel-cased keys expected by the UI
          firmName         : d.firm_name,
          entityType       : d.entity_type,
          subType          : d.sub_type,
          companyLinkedIn  : d.company_linkedin,
          investmentStrategy: d.investment_strategy,
          sectorDetails    : d.sector_details
        });
      }
    }

    return json({ inserted });
  }

  /* ───────────── everything else ───────────── */
  return json({ error:'Method not allowed' }, 405);
}

/* helper */
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
