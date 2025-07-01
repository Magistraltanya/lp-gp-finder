/**
 * POST /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added, newFirms }
 */
export async function onRequest({ request, env }) {
  const { GEMINI_KEY, DB } = env;

  if (request.method !== "POST")
    return new Response("Use POST", { status: 405 });

  try {
    /* ---------- step 1: parameters ---------- */
    const { entityType, subType, sector, geo } = await request.json();
    if (!entityType || !subType || !sector || !geo) {
      return json({ error: "Missing one of entityType, subType, sector, geo" }, 400);
    }

    /* ---------- step 2: call Gemini ---------- */
    const prompt = `
Find 5 investment firms based on the query: "${subType}" in the "${sector}" sector, located in "${geo}".
Return ONLY a JSON array where each object has keys:
"firmName","website","country","about","investmentStrategy".`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    };

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
        GEMINI_KEY,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }
    );

    if (!geminiRes.ok)
      throw new Error(`Gemini error ${geminiRes.status}`);

    let text =
      (await geminiRes.json())?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    /* strip ``` wrappers if they appear */
    text = text.trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    let firms;
    try { firms = JSON.parse(text); } catch {
      throw new Error("Gemini did not return valid JSON.");
    }
    if (!Array.isArray(firms)) firms = [];

    /* ---------- step 3: ensure table ---------- */
    await DB.exec(
      "CREATE TABLE IF NOT EXISTS firms (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "website TEXT UNIQUE," +
      "firm_name TEXT," +
      "entity_type TEXT," +
      "sub_type TEXT," +
      "country TEXT," +
      "about TEXT," +
      "investment_strategy TEXT," +
      "sector TEXT," +
      "source TEXT," +
      "validated INTEGER DEFAULT 0," +
      "created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"
    );

    /* ---------- step 4: insert rows ---------- */
    const newFirms = [];
    for (const f of firms) {
      const website = (f.website || "").toLowerCase();
      if (!website) continue;

      const exists =
        await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1")
                .bind(website).first();
      if (exists) continue;

      await DB.prepare(
        "INSERT INTO firms (website, firm_name, entity_type, sub_type, country, " +
        "about, investment_strategy, sector, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Gemini');"
      ).bind(
        website,
        f.firmName || "",
        entityType,
        subType,
        f.country || geo,
        f.about || "",
        f.investmentStrategy || "",
        sector
      ).run();

      newFirms.push({
        entityType,
        firmName: f.firmName || "",
        subType,
        country: f.country || geo,
        website,
        about: f.about || "",
        investmentStrategy: f.investmentStrategy || "",
        sector,
        source: "Gemini",
        validated: false
      });
    }

    return json({ added: newFirms.length, newFirms });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

/* helper */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
