/**
 *  GET  /api/firms         → list all rows
 *  POST /api/firms         → bulk upload [{ …, contacts:[…] }]
 *                            returns { inserted:[rowObj,…] }
 */

export async function onRequest({ request, env }) {
  const { DB } = env;

  /* ───────── ensure table & column exist (idempotent) ───────── */
  await DB.exec(`CREATE TABLE IF NOT EXISTS firms(
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      website           TEXT UNIQUE,
      firm_name         TEXT,
      entity_type       TEXT,
      sub_type          TEXT,
      address           TEXT,
      country           TEXT,
      company_linkedin  TEXT,
      about             TEXT,
      investment_strategy TEXT,
      sector            TEXT,
      sector_details    TEXT,
      stage             TEXT,
      source            TEXT,
      validated         INTEGER DEFAULT 0,
      contacts_json     TEXT DEFAULT '[]',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  try { await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT`); } catch { /* already there */ }

  /* ──────────── GET : full list ─────────────────────────────── */
  if (request.method === "GET") {
    const rows = await DB.prepare("SELECT * FROM firms ORDER BY id DESC").all();
    const out  = rows.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || "[]") }));
    return json(out);
  }

  /* ──────────── POST : bulk upload ──────────────────────────── */
  if (request.method === "POST") {
    let list;
    try { list = await request.json(); } catch { return json({ error:"body must be JSON array" },400); }
    if (!Array.isArray(list) || !list.length) return json({ error:"array expected" },400);

    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];

    for (const r of list) {
      const uniq = (r.website || r.firmName || "").toLowerCase();
      if (!uniq) continue;                                // skip rows with no unique key

      try {
        const res = await stmt.bind(
          r.website || "",       r.firmName || "",
          r.entityType || "",    r.subType || "",
          r.address || "",       r.country || "",
          r.companyLinkedIn || "", r.about || "",
          r.investmentStrategy || "",
          r.sector || "",        r.sectorDetails || "",
          r.stage || "",
          JSON.stringify(r.contacts || [])
        ).run();

        if (res.meta.changes) {
          inserted.push({ id: res.meta.last_row_id, source:"Upload", validated:true, ...r });
        }
      } catch (dbErr) {
        // Any SQLite error for this row → skip & carry on; front-end still gets JSON
        console.error("DB insert error:", dbErr);
      }
    }

    return json({ inserted });
  }

  /* ──────────── anything else ──────────────────────────────── */
  return json({ error:"Method not allowed" },405);
}

/* helper */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type":"application/json" }
  });
}
