/**
 * POST  /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added:<number>, newFirms:[...] }
 */
export async function onRequestPost({ request, env }) {
  /* ── 0 — ENV ───────────────────────────────────────────────────────── */
  const { GEMINI_KEY, DB } = env;

  /* ── 1 — PARSE & NORMALISE INPUT ───────────────────────────────────── */
  const body = await request.json().catch(() => ({}));
  let { entityType = "", subType = "", sector = "", geo = "" } = body;

  const ETYPES   = ["LP", "GP", "Broker", "Other"];
  const LP_TYPES = {
    "endowment": "Endowment Fund",
    "sovereign": "Sovereign Wealth Fund",
    "bank": "Bank",
    "insurance": "Insurance Company",
    "university": "University",
    "pension": "Pension Fund",
    "economic development": "Economic Development Agency",
    "family": "Family Office",
    "foundation": "Foundation",
    "wealth": "Wealth Management Firm",
    "hni": "HNI",
    "hedge": "Hedge Fund",
    "fund of funds": "Fund of Funds"
  };
  const GP_TYPES = {
    "private equity": "Private Equity",
    "pe": "Private Equity",
    "venture capital": "Venture Capital",
    "vc": "Venture Capital",
    "angel": "Angel Investors",
    "cvc": "Corporate Development Team",
    "corporate": "Corporate Development Team",
    "incubator": "Incubator",
    "sbic": "SBIC",
    "bdc": "Business Development Company",
    "growth": "Growth Equity Firm",
    "accelerator": "Accelerator",
    "fof": "Fund of Funds",
    "angel group": "Angel Group",
    "asset": "Asset Management Firm",
    "angel fund": "Angel Investment Fund"
  };
  const SECTORS = {
    "energy": "Energy",
    "materials": "Materials",
    "industrials": "Industrials",
    "consumer discretionary": "Consumer Discretionary",
    "consumer staples": "Consumer Staples",
    "health": "Health Care",
    "healthcare": "Health Care",
    "financial": "Financials",
    "fin": "Financials",
    "information technology": "Information Technology",
    "it": "Information Technology",
    "tech": "Information Technology",
    "communication": "Communication Services",
    "utilities": "Utilities",
    "real estate": "Real Estate",
    "sector agnostic": "Sector Agnostic"
  };

  const norm = (val = "") => val.toLowerCase().trim();

  /* entityType (LP | GP | Broker | Other) */
  entityType = ETYPES.find(t => t.toLowerCase() === norm(entityType)) || "LP";

  /* subType */
  if (entityType === "LP") {
    const k = Object.keys(LP_TYPES).find(k => norm(subType).includes(k));
    subType = k ? LP_TYPES[k] : "Other";
  } else if (entityType === "GP") {
    const k = Object.keys(GP_TYPES).find(k => norm(subType).includes(k));
    subType = k ? GP_TYPES[k] : "Other";
  } else {
    subType = "Other";
  }

  /* sector */
  {
    const k = Object.keys(SECTORS).find(k => norm(sector).includes(k));
    sector = k ? SECTORS[k] : "Sector Agnostic";
  }

  if (!geo) {
    return json({ error: "Geography (geo) is required." }, 400);
  }

  /* ── 2 — PROMPT ────────────────────────────────────────────────────── */
  const PROMPT = `
You are an expert LP/GP analyst.
Return ONLY a JSON array (no markdown). Follow ALL rules.

──────── MAIN FILTERS ────────
• entityType  : "${entityType}"
• specificType: "${subType}"
• sectorFocus : "${sector}"
• geography   : "${geo}"
Find 5 matching firms.

──────── ALLOWED VALUES (STRICT) ────────
${"```"}txt
Main types : LP · GP · Broker · Other
LP sub-types:
Endowment Fund · Sovereign Wealth Fund · Bank · Insurance Company · University · Pension Fund · Economic Development Agency · Family Office · Foundation · Wealth Management Firm · HNI · Hedge Fund · Fund of Funds · Other
GP sub-types:
Private Equity · Venture Capital · Angel Investors · Corporate Development Team · Incubator · SBIC · Business Development Company · Growth Equity Firm · Accelerator · Fund of Funds · Angel Group · Asset Management Firm · Angel Investment Fund · Other
Sectors:
Energy · Materials · Industrials · Consumer Discretionary · Consumer Staples · Health Care · Financials · Information Technology · Communication Services · Utilities · Real Estate · Sector Agnostic
Stages:
Pre-Seed / Incubation · Seed / Angel · Early VC (Series A) · Mid VC (Series B–C) · Late VC / Pre-IPO · Growth Equity · Buyout / Control · Special Situations / Distressed · Private Debt / Mezzanine · Infrastructure / Real Assets · Secondaries · Fund-of-Funds / Multi-Manager · Multi-Stage · Other · Stage Agnostic
${"```"}

──────── RETURN STRUCTURE ────────
[
  {
    "firmName":"",
    "entityType":"",
    "subType":"",
    "address":"",
    "country":"",
    "website":"",
    "companyLinkedIn":"",
    "about":"",
    "investmentStrategy":"",
    "sector":"",
    "sectorDetails":"",
    "stage":"",
    "contacts":[]
  }
]
`;

  /* ── 3 — CALL GEMINI ──────────────────────────────────────────────── */
  const gRes = await fetch(
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

  if (!gRes.ok) return json({ error: `Gemini ${gRes.status}` }, 502);

  const gJson = await gRes.json();
  const raw = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  let firmsAI = [];
  try {
    firmsAI = JSON.parse(raw);
    if (!Array.isArray(firmsAI)) throw new Error("not array");
  } catch {
    return json({ error: "Gemini returned invalid JSON." }, 500);
  }

  /* ── 4 — ENSURE TABLE ────────────────────────────────────────────── */
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

  /* ── 5 — INSERT / DEDUP ──────────────────────────────────────────── */
  let added = 0;
  const newFirms = [];

  for (const f of firmsAI) {
    const key = (f.website || f.firmName || "").toLowerCase();
    if (!key) continue;

    const dup = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1")
      .bind(key)
      .first();
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
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
