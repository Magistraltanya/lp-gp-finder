/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Reply: { added, newFirms:[ { … , id } ] }
 */

export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;

    /* ── 0 ▸ parse & lower-case helpers ───────────────────────── */
    const b = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = b;
    const lc = s => (s || "").toLowerCase().trim();

    /* ── 1 ▸ normalise Entity-Type, Sub-type, Sector ──────────── */
    const ETYPES = ["LP", "GP", "Broker", "Other"];

    const MAP_LP = {
      "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank","insurance":"Insurance Company",
      "university":"University","pension":"Pension Fund","economic development":"Economic Development Agency",
      "family":"Family Office","foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI",
      "hedge":"Hedge Fund","fund of funds":"Fund of Funds"
    };
    const MAP_GP = {
      "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital","vc":"Venture Capital",
      "angel":"Angel Investors","corporate":"Corporate Development Team","cvc":"Corporate Development Team",
      "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
      "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group",
      "asset":"Asset Management Firm","angel fund":"Angel Investment Fund"
    };
    const MAP_SECTOR = {
      "energy":"Energy","materials":"Materials","industrials":"Industrials",
      "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
      "health":"Health Care","healthcare":"Health Care",
      "financial":"Financials","fin":"Financials",
      "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
      "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
      "sector agnostic":"Sector Agnostic"
    };

    entityType = ETYPES.find(t => lc(t) === lc(entityType)) || "LP";

    if (entityType === "LP") {
      const k = Object.keys(MAP_LP).find(k => lc(subType).includes(k));
      subType  = k ? MAP_LP[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(MAP_GP).find(k => lc(subType).includes(k));
      subType  = k ? MAP_GP[k] : "Other";
    } else subType = "Other";

    {
      const k = Object.keys(MAP_SECTOR).find(k => lc(sector).includes(k));
      sector = k ? MAP_SECTOR[k] : "Sector Agnostic";
    }

    if (!geo) return json({ error: "geo is required" }, 400);

    /* ── 2 ▸ “water-tight” Gemini prompt ─────────────────────── */
    const PROMPT = `
You are an expert LP / GP data-analyst.

──────────────────────── STEP 1 — CLASSIFY ────────────────────────
Use **only** these lists.
Main types  : LP · GP · Broker · Other
LP subtypes : Endowment Fund · Sovereign Wealth Fund · Bank · Insurance Company · University · Pension Fund · Economic Development Agency · Family Office · Foundation · Wealth Management Firm · HNI · Hedge Fund · Fund of Funds · Other
GP subtypes : Private Equity · Venture Capital · Angel Investors · Corporate Development Team · Incubator · SBIC · Business Development Company · Growth Equity Firm · Accelerator · Fund of Funds · Angel Group · Asset Management Firm · Angel Investment Fund · Other

──────────────────────── STEP 2 — CORE FIELDS ─────────────────────
For each firm capture **every** field:
firmName · entityType · subType · address · country · website · companyLinkedIn · about · investmentStrategy · sector · sectorDetails · stage  
• “about” = 2–3 factual sentences in your own words.  
• “investmentStrategy” = include AUM / sectors / stages / geography / cheque-size if stated.  
• Map sector & subtype spellings to the allowed lists.

──────────────────────── STEP 3 — OUTPUT ──────────────────────────
Return *only* a JSON array (no markdown, no fences) of exactly 5 objects:
[
  {
    "firmName":"",            "entityType":"",      "subType":"",
    "address":"",             "country":"",
    "website":"",             "companyLinkedIn":"",
    "about":"",               "investmentStrategy":"",
    "sector":"",              "sectorDetails":"",
    "stage":"",               "contacts":[]
  }
]

──────────────────────── TASK ─────────────────────────────────────
Find 5 firms that match *all* criteria:
• entityType  : "${entityType}"
• specificType: "${subType}"
• sectorFocus : "${sector}"
• geography   : "${geo}"
`;

    /* ── 3 ▸ Gemini call (2 retries on 5xx) ──────────────────── */
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    let gRes;
    for (let n = 0; n < 3; n++) {
      gRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      if (gRes.ok) break;
      if (gRes.status >= 500) await new Promise(r => setTimeout(r, 400 * (n + 1)));
      else throw new Error(`Gemini ${gRes.status}`);
    }

    const gJ = await gRes.json();
    let txt = gJ?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    txt = txt.replace(/^```[a-z]*\s*/i, "").replace(/```$/,"").trim();   // strip fences

    let arr; try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0; }
    catch { return json({ error: "Gemini bad JSON" }, 500); }

    /* ── 4 ▸ ensure table ────────────────────────────────────── */
    await DB.exec(`CREATE TABLE IF NOT EXISTS firms(id INTEGER PRIMARY KEY AUTOINCREMENT,website TEXT UNIQUE,firm_name TEXT,entity_type TEXT,sub_type TEXT,address TEXT,country TEXT,company_linkedin TEXT,about TEXT,investment_strategy TEXT,sector TEXT,sector_details TEXT,stage TEXT,source TEXT,validated INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

    /* ── 5 ▸ insert & dedupe ─────────────────────────────────── */
    const stmt = await DB.prepare(`INSERT INTO firms(website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0)`);

    let added = 0, newFirms = [];
    for (const f of arr) {
      const uniq = (f.website || f.firmName || "").toLowerCase();
      if (!uniq) continue;
      const dup = await DB.prepare("SELECT id FROM firms WHERE website=? LIMIT 1").bind(uniq).first();
      if (dup) continue;

      const res = await stmt.bind(
        f.website || "", f.firmName || "", f.entityType || entityType, f.subType || subType,
        f.address || "", f.country || geo, f.companyLinkedIn || "", f.about || "",
        f.investmentStrategy || "", f.sector || sector, f.sectorDetails || "", f.stage || ""
      ).run();

      newFirms.push({ id: res.meta.last_row_id, validated: false, source: "Gemini", contacts: [], ...f });
      added++;
    }

    return json({ added, newFirms });
  } catch (err) {
    console.error(err);
    return json({ error: String(err.message || err) }, 500);
  }
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
