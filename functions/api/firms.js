/**
 * GET  /api/firms          → list all rows
 * POST /api/firms          → bulk insert from spreadsheet upload
 *      body : [{ …, contacts:[{…}] }]
 *      returns { inserted:[rowObj,…] }
 */

export async function onRequest({ request, env }) {
  const { DB } = env;

  /* ——— ensure contacts_json column exists ——— */
  try { await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT`); } catch {}

  if (request.method === "GET") {
    const rows = await DB.prepare("SELECT * FROM firms ORDER BY id DESC").all();
    const out = rows.results.map(r => ({ ...r, contacts: JSON.parse(r.contacts_json || "[]") }));
    return json(out);
  }

  if (request.method === "POST") {
    const arr = await request.json().catch(() => null);
    if (!Array.isArray(arr) || !arr.length) return json({ error: "array expected" }, 400);

    const stmt = await DB.prepare(`INSERT INTO firms(website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated,contacts_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1,?13)`);

    const inserted = [];
    for (const r of arr) {
      const uniq = (r.website || r.firmName || "").toLowerCase();
      if (!uniq) continue;
      const dup = await DB.prepare("SELECT id FROM firms WHERE website=? LIMIT 1").bind(uniq).first();
      if (dup) continue;

      const contactsJSON = JSON.stringify(r.contacts || []);
      const res = await stmt.bind(
        r.website || "", r.firmName || "", r.entityType || "", r.subType || "", r.address || "", r.country || "",
        r.companyLinkedIn || "", r.about || "", r.investmentStrategy || "", r.sector || "",
        r.sectorDetails || "", r.stage || "", contactsJSON
      ).run();

      inserted.push({ id: res.meta.last_row_id, ...r, source: "Upload", validated: true });
    }
    return json({ inserted });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
