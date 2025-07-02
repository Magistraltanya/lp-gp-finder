import { ensureTable } from './_ensureTable.js';

/**
 * GET  /api/firms    – list rows (contacts_json → contacts[])
 * POST /api/firms    – bulk upload; body = JSON array pre-processed in the browser
 */
export async function onRequest ({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  /* ────────────────────────────── GET ────────────────────────────── */
  if (request.method === 'GET') {
    const rs  = await DB.prepare('SELECT id, firm_name, entity_type, sub_type, address, country, website, company_linkedin, about, investment_strategy, sector, sector_details, stage, source, validated, contacts_json FROM firms ORDER BY id DESC').all();
    const out = rs.results.map(r => ({
      ...r,
      contacts : JSON.parse(r.contacts_json || '[]')
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
      if (raw.length > 10_000_000)
        return json({ error : 'File too large – please split it.' }, 413);
    }

    /* 2 ▸ parse & basic validation */
    let firmsToInsert;
    try {
      firmsToInsert = JSON.parse(raw);
      if (!Array.isArray(firmsToInsert) || !firmsToInsert.length) throw 0;
    } catch {
      return json({ error : 'Body must be a non-empty JSON array.' }, 400);
    }

    /* 3 ▸ prepared statement – one INSERT per firm */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];

    /* 4 ▸ insert each pre-processed firm from the front-end */
    for (const firm of firmsToInsert) {
      const key = (firm.website || firm.firmName || '').toLowerCase().trim();
      if (!key) continue;

      const res = await stmt.bind(
        firm.website            || '',
        firm.firmName           || '',
        firm.entityType         || 'Other',
        firm.subType            || 'Other',
        firm.address            || '',
        firm.country            || '',
        firm.companyLinkedIn    || '',
        firm.about              || '',
        firm.investmentStrategy || '',
        firm.sector             || 'Sector Agnostic',
        firm.sectorDetails      || '',
        firm.stage              || 'Stage Agnostic',
        JSON.stringify(firm.contacts || []) // This is the fix: use the pre-aggregated contacts
      ).run();

      if (res.meta.changes) {
        inserted.push({
          id                : res.meta.last_row_id,
          source            : 'Upload',
          validated         : true,
          // pass all firm data back to front-end, mapping snake_case to camelCase for consistency
          firmName          : firm.firmName,
          entityType        : firm.entityType,
          subType           : firm.subType,
          companyLinkedIn   : firm.companyLinkedIn,
          investmentStrategy: firm.investmentStrategy,
          sectorDetails     : firm.sectorDetails,
          contacts          : firm.contacts || [],
          ...firm
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
