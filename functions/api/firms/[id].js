/**
 * DELETE /api/firms/:id   → 204 on success
 */
export async function onRequest({ request, env, params }) {
  if (request.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const id = parseInt(params.id, 10);
  if (!id) return new Response("Bad id", { status: 400 });

  await env.DB.prepare("DELETE FROM firms WHERE id=?").bind(id).run();
  return new Response(null, { status: 204 });
}
