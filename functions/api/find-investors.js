/**
 * POST /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added, newFirms }
 */
export async function onRequest({ request, env }) {
  // Shortcuts to our secrets and database
  const { GEMINI_KEY, DB } = env;

  try {
     // ⬇️ add this guard line
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    // ───────── step 1: grab the four parameters ─────────
    const { entityType, subType, sector, geo } = await request.json();
    if (!entityType || !subType || !sector || !geo) {
      return json({ error: "Missing one of entityType, subType, sector, geo" }, 400);
    }

    // ───────── step 2: ask Gemini for five firms ─────────
    const prompt = `
Find 5 investment firms based on the query: "${subType}" in the "${sector}" sector, located in "${geo}".
For each firm return JSON with keys:
"firmName","website","country","about","investmentStrategy",
"categorizedSubType","categorizedSector"
Return ONLY the JSON array.`;
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );
    if (!geminiRes.ok) {
      throw new Error(`Gemini error ${geminiRes.status}`);
    }
    const geminiJson = await geminiRes.json();
    const firstText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    let firms = [];
    try {
      firms = JSON.parse(firstText);
    } catch {
      throw new Error("Gemini did not return valid JSON.");
    }

    // ───────── step 3: make sure we have a table ─────────
    await DB.exec(`
      CREATE TABLE IF NOT EXISTS firms (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        website       TEXT UNIQUE,
        firm_name     TEXT,
        entity_type   TEXT,
        sub_type      TEXT,
        country       TEXT,
        about         TEXT,
        investment_strategy TEXT,
        sector        TEXT,
        source        TEXT,
        validated     INTEGER DEFAULT 0,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ───────── step 4: insert new rows, skip duplicates ─────────
    const newFirms = [];
    for (const f of firms) {
      const website = (f.website || "").toLowerCase();
      if (!website) continue;

      const exists = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1").bind(website).first();
      if (exists) continue; // duplicate

      await DB.prepare(
        `INSERT INTO firms (website, firm_name, entity_type, sub_type, country, about,
                            investment_strategy, sector, source, validated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Gemini', 0);`
      )
        .bind(
          website,
          f.firmName || "",
          entityType,
          f.categorizedSubType || subType,
          f.country || geo,
          f.about || "",
          f.investmentStrategy || "",
          f.categorizedSector || sector
        )
        .run();

      newFirms.push({
        entityType,
        firmName: f.firmName || "",
        subType: f.categorizedSubType || subType,
        country: f.country || geo,
        website,
        about: f.about || "",
        investmentStrategy: f.investmentStrategy || "",
        sector: f.categorizedSector || sector,
        source: "Gemini",
        validated: false,
      });
    }

    return json({ added: newFirms.length, newFirms });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Helper: tiny wrapper to return JSON
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
