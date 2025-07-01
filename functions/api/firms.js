/**
 *  GET  /api/firms          → returns every row in the DB
 *  DELETE /api/firms/:id    → delete by numeric `id`
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const { DB } = env;

  try {
    if (request.method === "GET") {
      const rows = await DB.prepare("SELECT *, id AS _id FROM firms").all();
      return json(rows.results);
    }

    if (request.method === "DELETE") {
      const id = Number(params.id);
      if (!id) return json({ error: "bad id" }, 400);
      await DB.prepare("DELETE FROM firms WHERE id = ?").bind(id).run();
      return json({ ok: true });
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
