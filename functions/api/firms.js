/**
 * GET  /api/firms        → whole table  (ordered newest-first)
 * POST /api/firms        → bulk insert [{…}]   (from spreadsheet upload)
 *        returns { inserted:[rowObj,…] }
 */
export async function onRequest({ request, env }) {
  const { DB } = env;
  const url = new URL(request.url);

  if (request.method === "GET") {
    const rows = await DB.prepare("SELECT * FROM firms ORDER BY id DESC").all();
    return json(rows.results);
  }

  /* POST — upload */
  if (request.method === "POST") {
    const arr = await request.json().catch(() => null);
    if (!Array.isArray(arr) || !arr.length) return json({ error: "array required" }, 400);

    const stmt = await DB.prepare(`INSERT INTO firms(website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1)`);

    const inserted = [];
    for (const r of arr) {
      const key = (r.website || r.firmName || "").toLowerCase();
      if (!key) continue;
      const dup = await DB.prepare("SELECT id FROM firms WHERE website=? LIMIT 1").bind(key).first();
      if (dup) continue;

      const res = await stmt.bind(
        r.website || "", r.firmName || "", r.entityType || "", r.subType || "", r.address || "",
        r.country || "", r.companyLinkedIn || "", r.about || "", r.investmentStrategy || "",
        r.sector || "", r.sectorDetails || "", r.stage || ""
      ).run();

      inserted.push({ id: res.meta.last_row_id, ...r, source: "Upload", validated: true });
    }

    return json({ inserted });
  }

  return json({ error: "Method not allowed" }, 405);
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
