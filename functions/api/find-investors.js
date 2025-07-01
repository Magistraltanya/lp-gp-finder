/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Response: { added, newFirms }  –or–  { error }
 */
export async function onRequestPost(ctx) {
  /** ------------------------------------------------------------------
   *  0.  wrap everything so any thrown error becomes JSON we control
   * ------------------------------------------------------------------*/
  try {
    const { request, env } = ctx;
    const { GEMINI_KEY, DB } = env;          // <-- make sure the D1 binding is **DB**

    /* ---------- 1. PARSE & NORMALISE INPUT ---------------------------------- */
    const body = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = body;

    /* …… identical normalisation maps as before ……………………………………… */
    const ETYPES   = ["LP", "GP", "Broker", "Other"];
    const LP_TYPES = { "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank",
      "insurance":"Insurance Company","university":"University","pension":"Pension Fund",
      "economic development":"Economic Development Agency","family":"Family Office",
      "foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI","hedge":"Hedge Fund",
      "fund of funds":"Fund of Funds"};
    const GP_TYPES = { "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital","vc":"Venture Capital",
      "angel":"Angel Investors","cvc":"Corporate Development Team","corporate":"Corporate Development Team",
      "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
      "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group","asset":"Asset Management Firm",
      "angel fund":"Angel Investment Fund"};
    const SECTORS  = { "energy":"Energy","materials":"Materials","industrials":"Industrials",
      "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
      "health":"Health Care","healthcare":"Health Care","financial":"Financials","fin":"Financials",
      "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
      "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
      "sector agnostic":"Sector Agnostic" };

    const lc = s => s.toLowerCase().trim();

    entityType = ETYPES.find(t => lc(t) === lc(entityType)) || "LP";
    if (entityType === "LP") {
      const k = Object.keys(LP_TYPES).find(k => lc(subType).includes(k));
      subType = k ? LP_TYPES[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(GP_TYPES).find(k => lc(subType).includes(k));
      subType = k ? GP_TYPES[k] : "Other";
    } else {
      subType = "Other";
    }
    {
      const k = Object.keys(SECTORS).find(k => lc(sector).includes(k));
      sector = k ? SECTORS[k] : "Sector Agnostic";
    }
    if (!geo) return json({ error: "geo is required" }, 400);

    /* ---------- 2. BUILD PROMPT --------------------------------------------- */
    const PROMPT = /* same prompt as before, omitted for brevity */ `
You are an expert LP/GP analyst … (unchanged)
`;

    /* ---------- 3. CALL GEMINI --------------------------------------------- */
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }] }],
          generationConfig: { response_mime_type: "application/json" }   // ✅ correct snake-case key
        })
      }
    );

    // If Google replies with HTML or text, treat it as error early
    const ctype = gRes.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) {
      const txt = await gRes.text();
      throw new Error(`Gemini non-JSON response (${gRes.status}): ${txt.slice(0,120)}…`);
    }
    const gJson = await gRes.json();
    const raw   = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    let firmsAI;
    try { firmsAI = JSON.parse(raw); } catch {
      throw new Error("Gemini returned invalid JSON");
    }
    if (!Array.isArray(firmsAI)) throw new Error("Gemini did not return an array");

    /* ---------- 4. ENSURE TABLE -------------------------------------------- */
    await DB.exec(`
      CREATE TABLE IF NOT EXISTS firms (
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    /* ---------- 5. INSERT (dedupe on website) ------------------------------ */
    let added = 0;
    const newFirms = [];

    for (const f of firmsAI) {
      const key = (f.website || f.firmName || "").toLowerCase();
      if (!key) continue;

      const dup = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1").bind(key).first();
      if (dup) continue;

      await DB.prepare(
        `INSERT INTO firms (website, firm_name, entity_type, sub_type, address, country,
                            company_linkedin, about, investment_strategy,
                            sector, sector_details, stage, source, validated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gemini', 0)`
      ).bind(
        f.website || "",
        f.firmName || "",
        f.entityType || entityType,
        f.subType || subType,
        f.address || "",
        f.country || geo,
        f.companyLinkedIn || "",
        f.about || "",
        f.investmentStrategy || "",
        f.sector || sector,
        f.sectorDetails || "",
        f.stage || ""
      ).run();

      newFirms.push({
        uid: `g${Date.now()}_${Math.random()}`,
        ...f,
        validated: false,
        source: "Gemini",
        contacts: []
      });
      added++;
    }

    return json({ added, newFirms });
  } catch (err) {
    // log to Wrangler/Pages logs:
    console.error("find-investors error:", err);
    return json({ error: String(err.message || err) }, 500);
  }
}

/* helper */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
