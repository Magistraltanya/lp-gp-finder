/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Return: { added, newFirms } | { error }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;
    let firmsAI = [];

    /* ---------- 1  Parse + normalise inputs ---------------------------- */
    const b = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = b;

    const ETYPES = ["LP", "GP", "Broker", "Other"];
    const LP = {
      "endowment": "Endowment Fund", "sovereign": "Sovereign Wealth Fund", "bank": "Bank",
      "insurance": "Insurance Company", "university": "University", "pension": "Pension Fund",
      "economic development": "Economic Development Agency", "family": "Family Office",
      "foundation": "Foundation", "wealth": "Wealth Management Firm", "hni": "HNI",
      "hedge": "Hedge Fund", "fund of funds": "Fund of Funds"
    };
    const GP = {
      "private equity": "Private Equity", "pe": "Private Equity",
      "venture capital": "Venture Capital", "vc": "Venture Capital",
      "angel": "Angel Investors", "cvc": "Corporate Development Team", "corporate": "Corporate Development Team",
      "incubator": "Incubator", "sbic": "SBIC", "bdc": "Business Development Company",
      "growth": "Growth Equity Firm", "accelerator": "Accelerator", "fof": "Fund of Funds",
      "angel group": "Angel Group", "asset": "Asset Management Firm", "angel fund": "Angel Investment Fund"
    };
    const SECT = {
      "energy": "Energy", "materials": "Materials", "industrials": "Industrials",
      "consumer discretionary": "Consumer Discretionary", "consumer staples": "Consumer Staples",
      "health": "Health Care", "healthcare": "Health Care",
      "financial": "Financials", "fin": "Financials",
      "information technology": "Information Technology", "it": "Information Technology", "tech": "Information Technology",
      "communication": "Communication Services", "utilities": "Utilities", "real estate": "Real Estate",
      "sector agnostic": "Sector Agnostic"
    };
    const lc = s => s.toLowerCase().trim();

    entityType = ETYPES.find(t => lc(t) === lc(entityType)) || "LP";
    if (entityType === "LP")   subType = LP[Object.keys(LP).find(k => lc(subType).includes(k))]   ?? "Other";
    if (entityType === "GP")   subType = GP[Object.keys(GP).find(k => lc(subType).includes(k))]   ?? "Other";
    sector = SECT[Object.keys(SECT).find(k => lc(sector).includes(k))] ?? "Sector Agnostic";
    if (!geo) return json({ error: "geo is required" }, 400);

    /* ---------- 2  Prompt ------------------------------------------------ */
    const PROMPT = `
You are an expert LP/GP analyst.  STRICTLY return a JSON array matching this schema (no markdown):

{
  "firmName":"",
  "entityType":"",      // LP | GP | Broker | Other  (MUST be exact)
  "subType":"",         // MUST be from the canonical subtype lists below
  "address":"", "country":"", "website":"", "companyLinkedIn":"",
  "about":"", "investmentStrategy":"",
  "sector":"",          // one or comma-sep list from canonical sectors below
  "sectorDetails":"",   // exact niche wording if any
  "stage":"",           // comma-sep stages (canonical list)
  "contacts":[]
}

•  If user query spells a synonym, normalise it:
   "PE"→"Private Equity", "Health"→"Health Care", etc.
•  Your output values MUST be chosen from the lists:

Main types: LP · GP · Broker · Other
LP sub-types:
Endowment Fund · Sovereign Wealth Fund · Bank · Insurance Company · University · Pension Fund · Economic Development Agency · Family Office · Foundation · Wealth Management Firm · HNI · Hedge Fund · Fund of Funds · Other
GP sub-types:
Private Equity · Venture Capital · Angel Investors · Corporate Development Team · Incubator · SBIC · Business Development Company · Growth Equity Firm · Accelerator · Fund of Funds · Angel Group · Asset Management Firm · Angel Investment Fund · Other
Sectors:
Energy · Materials · Industrials · Consumer Discretionary · Consumer Staples · Health Care · Financials · Information Technology · Communication Services · Utilities · Real Estate · Sector Agnostic
Stages:
Pre-Seed / Incubation · Seed / Angel · Early VC (Series A) · Mid VC (Series B–C) · Late VC / Pre-IPO · Growth Equity · Buyout / Control · Special Situations / Distressed · Private Debt / Mezzanine · Infrastructure / Real Assets · Secondaries · Fund-of-Funds / Multi-Manager · Multi-Stage · Other · Stage Agnostic

FIND exactly **5** firms that match:
• entityType  = ${entityType}
• subType     = ${subType}
• sectorFocus = ${sector}
• geography   = ${geo}

ONLY return the JSON array — no explanation, no markdown.
`;

    /* ---------- 3  Call Gemini (retry 3×) ------------------------------ */
    async function callGemini(prompt) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
      for (let i = 0; i < 3; i++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });
        if (res.ok) return res;
        if (res.status >= 500) await new Promise(r => setTimeout(r, i ? 750 : 250));
        else throw new Error(`Gemini ${res.status}`);
      }
      throw new Error("Gemini 503 (after 3 attempts)");
    }

    const gJson = await (await callGemini(PROMPT)).json();
    const raw   = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    try { firmsAI = JSON.parse(raw); } catch { throw new Error("Gemini returned non-JSON"); }
    if (!Array.isArray(firmsAI)) throw new Error("Gemini did not return an array");

    /* ---------- 4  Ensure table ---------------------------------------- */
    await DB.exec(`CREATE TABLE IF NOT EXISTS firms(id INTEGER PRIMARY KEY AUTOINCREMENT,website TEXT UNIQUE,firm_name TEXT,entity_type TEXT,sub_type TEXT,address TEXT,country TEXT,company_linkedin TEXT,about TEXT,investment_strategy TEXT,sector TEXT,sector_details TEXT,stage TEXT,source TEXT,validated INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

    /* ---------- 5  Insert & dedupe ------------------------------------- */
    let added = 0;
    const newFirms = [];
    for (const f of firmsAI) {
      const key = (f.website || f.firmName || "").toLowerCase();
      if (!key) continue;

      const dup = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1").bind(key).first();
      if (dup) continue;

      await DB.prepare(
        `INSERT INTO firms(website, firm_name, entity_type, sub_type, address, country,
                           company_linkedin, about, investment_strategy,
                           sector, sector_details, stage, source, validated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gemini', 0)`
      ).bind(
        f.website || "", f.firmName || "", f.entityType || entityType, f.subType || subType,
        f.address || "", f.country || geo, f.companyLinkedIn || "", f.about || "",
        f.investmentStrategy || "", f.sector || sector, f.sectorDetails || "", f.stage || ""
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
    console.error("find-investors error:", err);
    return json({ error: String(err.message || err) }, 500);
  }
}

/* utility */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
