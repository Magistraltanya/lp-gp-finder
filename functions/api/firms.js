/**
 * GET  /api/firms
 * POST /api/firms   (bulk upload)
 */
export async function onRequest({ request, env }) {
  const { DB } = env;

  /* ensure table & contacts_json column */
  await DB.exec(`CREATE TABLE IF NOT EXISTS firms(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website TEXT UNIQUE,
    firm_name TEXT,
    entity_type TEXT,
    sub_type TEXT,
    address TEXT,
    country TEXT,
    company_linkedin TEXT,
    about TEXT,
    investment_strategy TEXT,
    sector TEXT,
    sector_details TEXT,
    stage TEXT,
    source TEXT,
    validated INTEGER DEFAULT 0,
    contacts_json TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  try { await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT`);} catch {}

  /* ---------- GET all ---------- */
  if (request.method === "GET") {
    const rows = await DB.prepare("SELECT * FROM firms ORDER BY id DESC").all();
    return json(rows.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || "[]") })));
  }

  /* ---------- POST bulk upload ---------- */
  if (request.method === "POST") {
    const list = await request.json().catch(() => null);
    if (!Array.isArray(list) || !list.length) return json({ error: "array expected" }, 400);

    const stmt = await DB.prepare(
      `INSERT OR IGNORE INTO firms
       (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
        sector,sector_details,stage,source,validated,contacts_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)`
    );

    const inserted = [];
    for (const r of list) {
      const key = (r.website || r.firmName || "").toLowerCase();
      if (!key) continue;

      const res = await stmt.bind(
        r.website || "", r.firmName || "", r.entityType || "", r.subType || "", r.address || "", r.country || "",
        r.companyLinkedIn || "", r.about || "", r.investmentStrategy || "",
        r.sector || "", r.sectorDetails || "", r.stage || "",
        JSON.stringify(r.contacts || [])
      ).run();

      if (res.meta.changes) inserted.push({ id: res.meta.last_row_id, source:"Upload", validated:true, ...r });
    }
    return json({ inserted });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
