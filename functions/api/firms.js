import { ensureTable } from './_ensureTable.js';

/**
 *  GET  /api/firms   – list rows (contacts_json → contacts[])
 *  POST /api/firms   – bulk upload; body = JSON array created in the browser
 *
 *  Upload flow
 *  ────────────
 *   1. Stream body (≤ 10 MB) so huge XLSX exports do not crash the worker.
 *   2. Parse → array of flat rows.
 *   3. Group by unique key (website || firmName) :
 *        ─ first row supplies scalar company fields
 *        ─ every row may add one contact   →   merged into contacts[ ]
 *   4. INSERT … ON IGNORE once per company → DB stays unique
 *   5. Return the rows that were really inserted so the UI can append them.
 */
export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);                    // make sure schema exists & up-to-date

  /* ────────────────────────────── GET ────────────────────────────── */
  if (request.method === 'GET') {
    const rs  = await DB.prepare('SELECT * FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({
      ...r,
      contacts : JSON.parse(r.contacts_json || '[]')   // ← give the UI its array
    }));
    return json(out);
  }

  /* ───────────────────────────── POST (upload) ───────────────────── */
  if (request.method === 'POST') {
    /* 1 ▸ read the streamed body – protect against giant files */
    let raw = '';
    const rdr = request.body.getReader();
    while (true) {
      const { value, done } = await rdr.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      if (raw.length > 10_000_000)              // ≈ 80 000 rows of plain JSON text
        return json({ error : 'File too large – please split it.' }, 413);
    }

    /* 2 ▸ parse & basic validation */
    let rows;
    try { rows = JSON.parse(raw); if (!Array.isArray(rows) || !rows.length) throw 0; }
    catch { return json({ error : 'Body must be a non-empty JSON array.' }, 400); }

    /* 3 ▸ bucket rows → 1 firm + N contacts */
    const buckets = new Map();                 // key → { data:{…}, contacts:[…] }

    for (const r of rows) {
      /* unique key */
      const key = (r.website || r.firmName || '').toLowerCase().trim();
      if (!key) continue;                      // skip completely blank lines

      /* first time we see this key → create container               */
      if (!buckets.has(key)) {
        buckets.set(key, {
          /* scalar company fields – take them from the *first* row only */
          data : {
            website            : r.website            || '',
            firm_name          : r.firmName           || '',
            entity_type        : r.entityType         || '',
            sub_type           : r.subType            || '',
            address            : r.address            || '',
            country            : r.country            || '',
            company_linkedin   : r.companyLinkedIn    || '',
            about              : r.about              || '',
            investment_strategy: r.investmentStrategy || '',
            sector             : r.sector             || '',
            sector_details     : r.sectorDetails      || '',
            stage              : r.stage              || ''
          },
          contacts : []                          // will be filled below
        });
      }

      /* append one contact if the row contains any contact info */
      const hasContact =
        r.contactName || r.designation || r.email || r.linkedIn || r.contactNumber;
      if (hasContact) {
        buckets.get(key).contacts.push({
          contactName   : r.contactName   || '',
          designation   : r.designation   || '',
          email         : r.email         || '',
          linkedIn      : r.linkedIn      || '',
          contactNumber : r.contactNumber || ''
        });
      }
    }

    if (!buckets.size) return json({ inserted : [] });

    /* 4 ▸ prepared statement – one INSERT per firm */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];

    /* 5 ▸ insert */
    for (const bucket of buckets.values()) {
      const d   = bucket.data;
      const res = await stmt.bind(
        d.website, d.firm_name, d.entity_type, d.sub_type, d.address, d.country,
        d.company_linkedin, d.about, d.investment_strategy,
        d.sector, d.sector_details, d.stage,
        JSON.stringify(bucket.contacts)
      ).run();

      if (res.meta.changes) {                  // row really inserted
        inserted.push({
          id         : res.meta.last_row_id,
          source     : 'Upload',
          validated  : true,
          contacts   : bucket.contacts,

          /* camel-case aliases expected by the front-end  */
          firmName          : d.firm_name,
          entityType        : d.entity_type,
          subType           : d.sub_type,
          companyLinkedIn   : d.company_linkedin,
          investmentStrategy: d.investment_strategy,
          sectorDetails     : d.sector_details,
          ...d
        });
      }
    }

    return json({ inserted });
  }

  /* ───────────────────── any other verb ───────────────────── */
  return json({ error : 'Method not allowed' }, 405);
}

/* utility */
function json (data, status = 200) {
  return new Response(
    JSON.stringify(data),
    { status, headers: { 'content-type' : 'application/json' } }
  );
}
