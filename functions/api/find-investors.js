/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Return (200): { added:<number>, newFirms:[...] }
 */

export async function onRequestPost({ request, env }) {
  // -- pull env vars
  const { GEMINI_KEY, DB } = env;

  /* 1 ─── input guard ──────────────────────────────────────────── */
  const { entityType, subType, sector, geo } = await request.json().catch(() => ({}));
  if (!entityType || !subType || !sector || !geo) {
    return json({ error: "Missing one of entityType, subType, sector, geo" }, 400);
  }

  /* 2 ─── build Gemini prompt ─────────────────────────────────── */
  const PROMPT = `
You are an expert LP / GP data analyst working for an investment-intelligence platform.
────────── STEP 1 — CLASSIFY FIRMS ──────────
Use the exact lists and rules below to decide LP/GP/Broker/Other **and** mandatory sub-types.
${"```txt"}
Main types: LP · GP · Broker · Other

LP sub-types:
Endowment Fund · Sovereign Wealth Fund · Bank · Insurance Company · University · Pension Fund · Economic Development Agency · Family Office · Foundation · Wealth Management Firm · HNI · Hedge Fund · Fund of Funds · Other

GP sub-types:
Private Equity · Venture Capital · Angel Investors · Corporate Development Team · Incubator · SBIC · Business Development Company · Growth Equity Firm · Accelerator · Fund of Funds · Angel Group · Asset Management Firm · Angel Investment Fund · Other
${"```"}

────────── STEP 2 — CORE COMPANY FIELDS ──────────
For every firm capture **exactly**:
• firmName · address · country · website · companyLinkedIn  
• about (2–3 factual sentences)  
• investmentStrategy (include AUM if stated, sectors, stages, geography, cheque size, focus)

────────── STEP 3 — SECTOR & STAGE NORMALISATION ──────────
Allowed sectors (exact spellings): Energy · Materials · Industrials · Consumer Discretionary · Consumer Staples · Health Care · Financials · Information Technology · Communication Services · Utilities · Real Estate · Sector Agnostic  
Allowed stages (exact spellings):
Pre-Seed / Incubation · Seed / Angel · Early VC (Series A) · Mid VC (Series B–C) · Late VC / Pre-IPO · Growth Equity · Buyout / Control · Special Situations / Distressed · Private Debt / Mezzanine · Infrastructure / Real Assets · Secondaries · Fund-of-Funds / Multi-Manager · Multi-Stage · Other · Stage Agnostic

────────── STEP 4 — OUTPUT ──────────
Return **ONLY** a JSON array (no markdown) with objects of shape:
{
  "firmName":        "",
  "entityType":      "",        // LP | GP | Broker | Other
  "subType":         "",        // one from lists above
  "address":         "",
  "country":         "",
  "website":         "",
  "companyLinkedIn": "",
  "about":           "",
  "investmentStrategy":"",
  "sector":          "",        // one or comma-sep list from allowed sectors
  "sectorDetails":   "",        // exact niche wording if available
  "stage":           "",        // comma-sep allowed stages
  "contacts": [                 // initially empty – we’ll enrich later
      /* { contactName, designation, linkedIn, email, contactNumber } */
  ]
}

────────── TASK ──────────
Find **5** firms that match:
• entityType:     "${entityType}"
• specific type:  "${subType}"
• sector focus:   "${sector}"
• geography:      "${geo}"

Remember: output pure JSON array, no markdown, no extra keys.
`;

  /* 3 ─── call Gemini (JSON only) ─────────────────────────────── */
  const gemRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );

  if (!gemRes.ok) {
    return json({ error: `Gemini ${gemRes.status}` }, 502);
  }

  const gemJson = await gemRes.json();
  const text = gemJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  let firmsFromAI;
  try {
    firmsFromAI = JSON.parse(text);
    if (!Array.isArray(firmsFromAI)) throw new Error("Not array");
  } catch {
    return json({ error: "Gemini did not return valid JSON." }, 500);
  }

  /* 4 ─── ensure table exists - (one-time) ───────────────────── */
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS firms (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      website           TEXT UNIQUE,
      firm_name         TEXT,
      entity_type       TEXT,
      sub_type          TEXT,
      address           TEXT,
      country           TEXT,
      company_linkedin  TEXT,
      about             TEXT,
      investment_strategy TEXT,
      sector            TEXT,
      sector_details    TEXT,
      stage             TEXT,
      source            TEXT,
      validated         INTEGER DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  /* 5 ─── insert new rows, skip duplicates ───────────────────── */
  let added = 0;
  const newFirms = [];

  for (const f of firmsFromAI) {
    const websiteKey = (f.website || f.firmName || "").toLowerCase();
    if (!websiteKey) continue;

    const dup = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1")
      .bind(websiteKey)
      .first();

    if (dup) continue; // skip duplicate

    await DB.prepare(
      `INSERT INTO firms (website, firm_name, entity_type, sub_type, address, country,
                          company_linkedin, about, investment_strategy,
                          sector, sector_details, stage, source, validated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gemini', 0)`
    )
      .bind(
        f.website || "",
        f.firmName || "",
        f.entityType || "",
        f.subType || subType,
        f.address || "",
        f.country || geo,
        f.companyLinkedIn || "",
        f.about || "",
        f.investmentStrategy || "",
        f.sector || sector,
        f.sectorDetails || "",
        f.stage || ""
      )
      .run();

    newFirms.push({
      uid: `g${Date.now()}_${Math.random()}`,
      ...f,
      validated: false,
      source: "Gemini",
      contacts: []   // keep empty for now
    });
    added++;
  }

  return json({ added, newFirms });
}

/* helper: JSON response */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
