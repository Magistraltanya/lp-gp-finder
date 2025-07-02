/**
 * POST  /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added:<number>, newFirms:[ { …schema… , id:<number> } ] }
 *
 * The “id” returned for each new firm is the D1 primary-key row-id.
 * That lets the front-end delete permanently with DELETE /api/firms/:id.
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ── ENV & helpers ─────────────────────────────────────────── */
    const { GEMINI_KEY, DB } = env;
    const body = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = body;
    const lc = s => (s || "").toLowerCase().trim();

    /* ── normalise Entity / Sub-type / Sector ─────────────────── */
    const ETYPES = ["LP", "GP", "Broker", "Other"];

    const LP = {
      "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank",
      "insurance":"Insurance Company","university":"University","pension":"Pension Fund",
      "economic development":"Economic Development Agency","family":"Family Office",
      "foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI",
      "hedge":"Hedge Fund","fund of funds":"Fund of Funds"
    };

    const GP = {
      "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital",
      "vc":"Venture Capital","angel":"Angel Investors","corporate":"Corporate Development Team",
      "cvc":"Corporate Development Team","incubator":"Incubator","sbic":"SBIC",
      "bdc":"Business Development Company","growth":"Growth Equity Firm","accelerator":"Accelerator",
      "fof":"Fund of Funds","angel group":"Angel Group","asset":"Asset Management Firm",
      "angel fund":"Angel Investment Fund"
    };

    const SECT = {
      "energy":"Energy","materials":"Materials","industrials":"Industrials",
      "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
      "health":"Health Care","healthcare":"Health Care","financial":"Financials","fin":"Financials",
      "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
      "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
      "sector agnostic":"Sector Agnostic"
    };

    /* entity type */
    entityType = ETYPES.find(t => lc(t) === lc(entityType)) || "LP";

    /* sub-type mapping */
    if (entityType === "LP") {
      const k = Object.keys(LP).find(k => lc(subType).includes(k));
      subType  = k ? LP[k] : "Other";
    } else if (entityType === "GP") {
      const k = Object.keys(GP).find(k => lc(subType).includes(k));
      subType  = k ? GP[k] : "Other";
    } else {
      subType = "Other";
    }

    /* sector mapping */
    {
      const k = Object.keys(SECT).find(k => lc(sector).includes(k));
      sector = k ? SECT[k] : "Sector Agnostic";
    }

    if (!geo) return json({ error: "geo is required" }, 400);

    /* ── build Gemini prompt ───────────────────────────────────── */
    const PROMPT = `
You are an expert LP / GP data analyst working for an investment-intelligence platform.

────────── STEP 1 — CLASSIFY FIRMS ──────────
… (long classification rubric you had before) …

────────── TASK ──────────
Find **5** firms that match:
• entityType  : "${entityType}"
• specificType: "${subType}"
• sectorFocus : "${sector}"
• geography   : "${geo}"

Return ONLY a JSON array with the exact schema.
`;

    /* ── call Gemini (retry on 5xx) ───────────────────────────── */
    async function callGemini(prompt) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const gRes = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });
        if (gRes.ok) return gRes;                    // success
        if (gRes.status >= 500) {                    // retry 5xx
          await new Promise(r => setTimeout(r, attempt ? 800 : 300));
          continue;
        }
        throw new Error(`Gemini ${gRes.status}`);
      }
      throw new Error("Gemini 503 (after retries)");
    }

    const gRes   = await callGemini(PROMPT);
    const gJson  = await gRes.json();
    const text   = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    let firmsAI;
    try { firmsAI = JSON.parse(text); if (!Array.isArray(firmsAI)) throw 0; }
    catch { return json({ error: "Gemini did not return valid JSON" }, 500); }

    /* ── ensure table exists ──────────────────────────────────── */
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

    /* ── insert new rows, return id for each ──────────────────── */
    const stmt = await DB.prepare(
      `INSERT INTO firms
         (website, firm_name, entity_type, sub_type, address, country,
          company_linkedin, about, investment_strategy,
          sector, sector_details, stage, source, validated)
       VALUES
         (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0)`
    );

    let added = 0;
    const newFirms = [];

    for (const f of firmsAI) {
      const key = (f.website || f.firmName || "").toLowerCase();
      if (!key) continue;

      const dup = await DB.prepare("SELECT id FROM firms WHERE website = ? LIMIT 1")
                          .bind(key).first();
      if (dup) continue;

      const res = await stmt.bind(
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
        id: res.meta.last_row_id,                // ← important for deletes
        validated: false,
        source: "Gemini",
        contacts: [],
        ...f
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
