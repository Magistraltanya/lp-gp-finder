/**
 *  GET    /api/firms           → all rows
 *  POST   /api/firms           → add rows [{ …schema… }]  (returns inserted with id)
 *  DELETE /api/firms/:id       → delete by numeric id
 */
export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const { DB } = env;

  try {
    /* ---------- GET all ---------- */
    if (request.method === "GET") {
      const rows = await DB.prepare("SELECT * FROM firms").all();
      return json(rows.results);
    }

    /* ---------- DELETE one ---------- */
    if (request.method === "DELETE") {
      const id = Number(params.id);
      if (!id) return json({ error: "bad id" }, 400);
      await DB.prepare("DELETE FROM firms WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    /* ---------- POST bulk insert (upload) ---------- */
    if (request.method === "POST") {
      const rows = await request.json().catch(() => null);
      if (!Array.isArray(rows) || !rows.length) return json({ error: "rows must be array" }, 400);

      const inserted = [];
      const stmt = await DB.prepare(
        `INSERT INTO firms(website, firm_name, entity_type, sub_type, address, country,
                           company_linkedin, about, investment_strategy,
                           sector, sector_details, stage, source, validated)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Upload',1)`
      );

      for (const r of rows) {
        const websiteKey = (r.website || r.firmName || "").toLowerCase();
        if (!websiteKey) continue;
        const dup = await DB.prepare("SELECT id FROM firms WHERE website = ? LIMIT 1")
                            .bind(websiteKey).first();
        if (dup) continue;

        const res = await stmt.bind(
          r.website || "", r.firmName || "", r.entityType || "",
          r.subType || "", r.address || "", r.country || "",
          r.companyLinkedIn || "", r.about || "", r.investmentStrategy || "",
          r.sector || "", r.sectorDetails || "", r.stage || ""
        ).run();

        inserted.push({ ...r, id: res.meta.last_row_id });
      }
      return json({ inserted });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("firms API error:", err);
    return json({ error: String(err.message || err) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
