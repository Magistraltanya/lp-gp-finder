import { ensureTable } from './_ensureTable.js';

/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Returns { added, newFirms:[{ … , id }] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;
    await ensureTable(DB);                          // guarantees schema

    /* ── parse body & helpers ─────────────────────────── */
    const b = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = b;
    const lc = s => (s || "").toLowerCase().trim();

    /* ── fixed vocab translations ─────────────────────── */
    const TYPES = ["LP", "GP", "Broker", "Other"];
    const LP = {
      "endowment": "Endowment Fund", "sovereign": "Sovereign Wealth Fund",
      "bank": "Bank", "insurance": "Insurance Company", "university": "University",
      "pension": "Pension Fund", "economic development": "Economic Development Agency",
      "family": "Family Office", "foundation": "Foundation",
      "wealth": "Wealth Management Firm", "hni": "HNI",
      "hedge": "Hedge Fund", "fund of funds": "Fund of Funds"
    };
    const GP = {
      "private equity": "Private Equity", "pe": "Private Equity",
      "venture capital": "Venture Capital", "vc": "Venture Capital",
      "angel": "Angel Investors", "corporate": "Corporate Development Team",
      "cvc": "Corporate Development Team", "incubator": "Incubator",
      "sbic": "SBIC", "bdc": "Business Development Company",
      "growth": "Growth Equity Firm", "accelerator": "Accelerator",
      "fof": "Fund of Funds", "angel group": "Angel Group",
      "asset": "Asset Management Firm", "angel fund": "Angel Investment Fund"
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

    /* ── normalise inputs ─────────────────────────────── */
    entityType = TYPES.find(t => lc(t) === lc(entityType)) || "LP";

    if (entityType === "LP") {
      const k = Object.keys(LP).find(k => lc(subType).includes(k));
      subType = k ? LP[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(GP).find(k => lc(subType).includes(k));
      subType = k ? GP[k] : "Other";
    } else subType = "Other";

    {
      const k = Object.keys(SECT).find(k => lc(sector).includes(k));
      sector = k ? SECT[k] : "Sector Agnostic";
    }

    if (!geo) return json({ error: "geo is required" }, 400);

    /* ── Gemini prompt (more forceful) ─────────────────── */
    const PROMPT = `
You are an investment-intelligence analyst.
Return **exactly five (5)** firms **as pure JSON (no markdown)**.
For every firm ALL fields below **must be populated with real text** – never "N/A", "", null
(verify at least two open-web sources such as official website, LinkedIn, Crunchbase, filings).

Required keys:
firmName · entityType · subType · address · country · website · companyLinkedIn ·
about · investmentStrategy · sector · sectorDetails · stage · contacts (keep []) 

Constraints the result MUST satisfy:
  entityType  = "${entityType}"
  subType     = "${subType}"
  sector      = "${sector}"
  country     must include the text "${geo}"

Use exact spellings from the allowed lists.
`;

    /* ── Gemini call (retry on 5xx) ─────────────────────── */
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
      if (gRes.status >= 500) await new Promise(r => setTimeout(r, 450 * (i + 1)));
      else throw new Error(`Gemini ${gRes.status}`);
    }

    const gJson = await gRes.json();
   let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
txt = txt
        .replace(/^```[\s\S]*?\n/, '')   // first triple-back-tick block start
        .replace(/```$/, '')             // trailing fence
        .replace(/,\s*}/g, '}')          // dangling commas
        .replace(/,\s*]/g, ']')
        .trim();


    let arr;
    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0; }
    catch { return json({ error: "Gemini bad JSON" }, 500); }

    /* ── prepare insert stmt ────────────────────────────── */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')
    `);

    /* ── insert rows (skip any with missing critical data) ─ */
    const newFirms = [];
    for (const f of arr) {
      if (!(f.website && f.firmName && f.entityType && f.subType)) continue;   // skip junk rows

      // ignore rows that would generate duplicate key `website = "N/A"`
      if (lc(f.website) === "n/a") continue;

      const res = await stmt.bind(
        f.website.trim(),
        f.firmName.trim(),
        f.entityType.trim(),
        f.subType.trim(),
        f.address || "N/A",
        f.country || geo,
        f.companyLinkedIn || "N/A",
        f.about || "N/A",
        f.investmentStrategy || "N/A",
        f.sector || sector,
        f.sectorDetails || "Niche not stated",
        f.stage || "Stage Agnostic"
      ).run();

      if (res.meta.changes) {
        newFirms.push({ id: res.meta.last_row_id, validated: false, source: "Gemini", contacts: [], ...f });
      }
    }

    return json({ added: newFirms.length, newFirms });

  } catch (err) {
    console.error(err);
    return json({ error: String(err.message || err) }, 500);
  }
}

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { "content-type": "application/json" }
});
