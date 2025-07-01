/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Always returns JSON: { added, newFirms }  OR  { error }
 */
export async function onRequestPost({ request, env }) {
  try {
    /* ── ENV ───────────────────────────── */
    const { GEMINI_KEY, DB } = env;

    /* ── 1 ▸ parse + normalise input ───── */
    const b = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = b;

    const ETYPES = ["LP", "GP", "Broker", "Other"];
    const LP     = { "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank",
      "insurance":"Insurance Company","university":"University","pension":"Pension Fund",
      "economic development":"Economic Development Agency","family":"Family Office","foundation":"Foundation",
      "wealth":"Wealth Management Firm","hni":"HNI","hedge":"Hedge Fund","fund of funds":"Fund of Funds" };
    const GP     = { "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital",
      "vc":"Venture Capital","angel":"Angel Investors","cvc":"Corporate Development Team","corporate":"Corporate Development Team",
      "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
      "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group",
      "asset":"Asset Management Firm","angel fund":"Angel Investment Fund" };
    const SECT   = { "energy":"Energy","materials":"Materials","industrials":"Industrials",
      "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
      "health":"Health Care","healthcare":"Health Care","financial":"Financials","fin":"Financials",
      "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
      "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
      "sector agnostic":"Sector Agnostic" };
    const lc = s => s.toLowerCase().trim();

    entityType = ETYPES.find(t => lc(t) === lc(entityType)) || "LP";
    if (entityType === "LP") {
      const k = Object.keys(LP).find(k => lc(subType).includes(k));
      subType = k ? LP[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(GP).find(k => lc(subType).includes(k));
      subType = k ? GP[k] : "Other";
    } else {
      subType = "Other";
    }
    {
      const k = Object.keys(SECT).find(k => lc(sector).includes(k));
      sector = k ? SECT[k] : "Sector Agnostic";
    }
    if (!geo) return json({ error: "geo is required" }, 400);

    /* ── 2 ▸ Gemini prompt ─────────────── */
    const PROMPT = `
You are an expert LP/GP data analyst.
Return ONLY a JSON array (no markdown). Follow exactly this schema:

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

Find 5 firms that match:
• entityType  : "${entityType}"
• specificType: "${subType}"
• sectorFocus : "${sector}"
• geography   : "${geo}"
`;

/* ---- 3 ▸ Call Gemini – with retry ----------------------------------- */
async function callGemini(prompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent" +
    `?key=${GEMINI_KEY}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const gRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    /* 200 OK and JSON?  ───────── */
    if (gRes.ok) return gRes;

    /* 503 / 502 / 500 ⇒ retry │ 4xx ⇒ break immediately */
    if (gRes.status >= 500) {
      const wait = attempt === 0 ? 250 : 750; // ms
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Gemini ${gRes.status}`);
  }
  throw new Error("Gemini 503 (after 3 attempts)");
}

const gRes = await callGemini(PROMPT);
const gJson = await gRes.json();
const raw   = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";


  /* ── 4 ▸ Ensure table ─────────────────────────────────────────── */
await DB.exec(
  `CREATE TABLE IF NOT EXISTS firms(id INTEGER PRIMARY KEY AUTOINCREMENT,website TEXT UNIQUE,firm_name TEXT,entity_type TEXT,sub_type TEXT,address TEXT,country TEXT,company_linkedin TEXT,about TEXT,investment_strategy TEXT,sector TEXT,sector_details TEXT,stage TEXT,source TEXT,validated INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`
);


    /* ── 5 ▸ Insert & dedupe —–––––––––––––––––––––––––––––––––––– */
    let added = 0;
    const newFirms = [];

    for (const f of firmsAI) {
      const key = (f.website || f.firmName || "").toLowerCase();
      if (!key) continue;

      const dup = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1")
                          .bind(key).first();
      if (dup) continue;

      await DB.prepare(
        `INSERT INTO firms(website, firm_name, entity_type, sub_type, address, country,
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
