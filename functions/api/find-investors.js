/**
 * POST /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added, newFirms:[{ … , id }] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;

    /* ── parse + lower helpers ────────────────────────────── */
    const body = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = body;
    const lc = s => (s || "").toLowerCase().trim();

    /* ── fixed vocab maps ─────────────────────────────────── */
    const TYPES = ["LP", "GP", "Broker", "Other"];
    const LP = { "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank","insurance":"Insurance Company",
                 "university":"University","pension":"Pension Fund","economic development":"Economic Development Agency",
                 "family":"Family Office","foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI",
                 "hedge":"Hedge Fund","fund of funds":"Fund of Funds" };
    const GP = { "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital","vc":"Venture Capital",
                 "angel":"Angel Investors","corporate":"Corporate Development Team","cvc":"Corporate Development Team",
                 "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
                 "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group",
                 "asset":"Asset Management Firm","angel fund":"Angel Investment Fund" };
    const SECTOR = { "energy":"Energy","materials":"Materials","industrials":"Industrials",
                     "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
                     "health":"Health Care","healthcare":"Health Care",
                     "financial":"Financials","fin":"Financials",
                     "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
                     "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
                     "sector agnostic":"Sector Agnostic" };

    /* ── normalise params ────────────────────────────────── */
    entityType = TYPES.find(t => lc(t) === lc(entityType)) || "LP";

    if (entityType === "LP") {
      const k = Object.keys(LP).find(k => lc(subType).includes(k));
      subType = k ? LP[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(GP).find(k => lc(subType).includes(k));
      subType = k ? GP[k] : "Other";
    } else subType = "Other";

    { const k = Object.keys(SECTOR).find(k => lc(sector).includes(k));
      sector = k ? SECTOR[k] : "Sector Agnostic"; }

    if (!geo) return json({ error: "geo is required" }, 400);

    /* ── prompt ──────────────────────────────────────────── */
    const PROMPT = `
Return ONLY a JSON array (no markdown, no fences) of exactly 5 firms.

Each object must contain **every** field below; if truly unknown write "N/A" (never leave empty):

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

Constraints:
• entityType  = "${entityType}"
• subType     = "${subType}"
• sector      = "${sector}"
• country     includes "${geo}"
Use exact spellings from the allowed lists for entityType, subType, sector, stage.
`;

    /* ── Gemini call with 2 retries ───────────────────────── */
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    let gRes;
    for (let i = 0; i < 3; i++) {
      gRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      if (gRes.ok) break;
      if (gRes.status >= 500) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      else throw new Error(`Gemini ${gRes.status}`);
    }

    const gJ = await gRes.json();
    let txt = gJ?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    txt = txt.replace(/^```[a-z]*\s*/i, "").replace(/```$/,"").trim();

    let arr;
    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0; }
    catch { return json({ error: "Gemini bad JSON" }, 500); }

    /* ── ensure table / column ───────────────────────────── */
    await DB.exec(`CREATE TABLE IF NOT EXISTS firms(
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
      contacts_json TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
    try { await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT`);} catch {}

    const stmt = await DB.prepare(
      `INSERT OR IGNORE INTO firms
       (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
        sector,sector_details,stage,source,validated,contacts_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')`
    );

    /* ── insert ──────────────────────────────────────────── */
    let added = 0, out = [];
    for (const f0 of arr) {
      /* back-fill critical blanks with normalised params */
      const f = {
        firmName: f0.firmName || "N/A",
        entityType: f0.entityType && f0.entityType !== "N/A" ? f0.entityType : entityType,
        subType: f0.subType && f0.subType !== "N/A" ? f0.subType : subType,
        address: f0.address || "N/A",
        country: f0.country || geo,
        website: f0.website || "N/A",
        companyLinkedIn: f0.companyLinkedIn || "N/A",
        about: f0.about || "N/A",
        investmentStrategy: f0.investmentStrategy || "N/A",
        sector: f0.sector && f0.sector !== "N/A" ? f0.sector : sector,
        sectorDetails: f0.sectorDetails || "N/A",
        stage: f0.stage || "N/A",
        contacts: Array.isArray(f0.contacts) ? f0.contacts : []
      };

      const res = await stmt.bind(
        f.website, f.firmName, f.entityType, f.subType, f.address, f.country,
        f.companyLinkedIn, f.about, f.investmentStrategy,
        f.sector, f.sectorDetails, f.stage
      ).run();

      if (res.meta.changes) {  // inserted
        out.push({ id: res.meta.last_row_id, source:"Gemini", validated:false, ...f });
        added++;
      }
    }

    return json({ added, newFirms: out });

  } catch (err) {
    console.error(err);
    return json({ error: String(err.message || err) }, 500);
  }
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
