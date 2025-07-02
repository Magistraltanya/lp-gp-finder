import { ensureTable } from './_ensureTable.js';

/**
 *  GET  /api/firms         → full list
 *  POST /api/firms         → bulk upload [{ …, contacts:[…] }]
 *                            returns { inserted:[rowObj] }
 */
export async function onRequest({ request, env }) {
  const { DB } = env;
  await ensureTable(DB);

  /* ─────────── GET ─────────── */
  if (request.method === "GET") {
    const rows = await DB.prepare("SELECT * FROM firms ORDER BY id DESC").all();
    return json(rows.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || "[]") })));
  }

  /* ─────────── POST upload ─────────── */
  if (request.method === "POST") {
    let list;
    try { list = await request.json(); } catch { return json({ error: "body must be JSON array" }, 400); }
    if (!Array.isArray(list) || !list.length) return json({ error: "array expected" }, 400);

    const ins = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)
    `);

    const inserted = [];
    for (const r of list) {
      const key = (r.website || r.firmName || "").toLowerCase();
      if (!key) continue;                                            // skip if no unique key

      try {
        const res = await ins.bind(
          r.website || "", r.firmName || "", r.entityType || "", r.subType || "",
          r.address || "", r.country || "", r.companyLinkedIn || "", r.about || "",
          r.investmentStrategy || "", r.sector || "", r.sectorDetails || "", r.stage || "",
          JSON.stringify(r.contacts || [])
        ).run();

        if (res.meta.changes) inserted.push({ id: res.meta.last_row_id, source: "Upload", validated: true, ...r });

      } catch (e) {
        console.error("DB insert error (upload row skipped):", e);   // keeps loop alive
      }
    }

    return json({ inserted });
  }

  return json({ error: "Method not allowed" }, 405);
}

/* helper */
const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { "content-type": "application/json" }
});
