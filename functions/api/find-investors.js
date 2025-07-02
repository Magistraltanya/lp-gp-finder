import { ensureTable } from './_ensureTable.js';

/**
 * POST /api/find-investors
 * This function now uses a highly detailed prompt and post-processing to ensure structured, clean data.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    await ensureTable(DB);

    const b = await request.json().catch(() => ({}));
    let { entityType, subType, sector, geo } = b;

    if (!geo) return json({ error: 'Geography is a required field' }, 400);

    /* ─── NEW: Comprehensive Mapping Dictionaries for Normalization ────────────────── */
    const lc = s => (s || '').toLowerCase().trim();

    const MAIN_TYPES = {
      'lp': 'LP', 'limited partner': 'LP',
      'gp': 'GP', 'general partner': 'GP',
      'broker': 'Broker', 'placement agent': 'Broker', 'advisor': 'Broker',
      'other': 'Other'
    };

    const LP_TYPES = {
      'endowment': 'Endowment Fund', 'sovereign wealth fund': 'Sovereign Wealth Fund', 'bank': 'Bank',
      'insurance': 'Insurance Company', 'university': 'University', 'pension': 'Pension Fund',
      'economic development': 'Economic Development Agency', 'family office': 'Family Office',
      'foundation': 'Foundation', 'wealth management': 'Wealth Management Firm', 'hni': 'HNI',
      'hedge fund': 'Hedge Fund', 'fund of funds': 'Fund of Funds', 'fof': 'Fund of Funds'
    };

    const GP_TYPES = {
      'private equity': 'Private Equity', 'pe': 'Private Equity',
      'venture capital': 'Venture Capital', 'vc': 'Venture Capital',
      'angel investors': 'Angel Investors', 'corporate development': 'Corporate Development Teams', 'cvc': 'Corporate Development Teams',
      'incubator': 'Incubator', 'sbic': 'Small Business investment Companies (SBIC)',
      'bdc': 'Business Development Companies', 'growth equity': 'Growth Equity Firms',
      'accelerator': 'Accelerator', 'angel group': 'Angel Group', 'asset management': 'Asset Management Firms',
      'angel fund': 'Angel Investment Fund'
    };

    const SECTORS = {
      'energy': 'Energy', 'materials': 'Materials', 'industrials': 'Industrials',
      'consumer discretionary': 'Consumer Discretionary', 'consumer staples': 'Consumer Staples',
      'health': 'Health Care', 'healthcare': 'Health Care',
      'financials': 'Financials', 'fintech': 'Financials',
      'information technology': 'Information Technology', 'it': 'Information Technology', 'tech': 'Information Technology', 'software': 'Information Technology',
      'communication': 'Communication Services', 'telecom': 'Communication Services',
      'utilities': 'Utilities', 'real estate': 'Real Estate',
      'agnostic': 'Sector Agnostic'
    };

    const STAGES = {
      'pre-seed': 'Pre-Seed / Incubation', 'incubation': 'Pre-Seed / Incubation',
      'seed': 'Seed / Angel', 'angel': 'Seed / Angel',
      'series a': 'Early VC (Series A)', 'early vc': 'Early VC (Series A)',
      'series b': 'Mid VC (Series B–C)', 'series c': 'Mid VC (Series B–C)', 'mid vc': 'Mid VC (Series B–C)',
      'series d': 'Late VC / Pre-IPO', 'late vc': 'Late VC / Pre-IPO', 'pre-ipo': 'Late VC / Pre-IPO',
      'growth': 'Growth Equity', 'growth equity': 'Growth Equity',
      'buyout': 'Buyout / Control', 'control': 'Buyout / Control', 'lbo': 'Buyout / Control',
      'special situations': 'Special Situations / Distressed', 'distressed': 'Special Situations / Distressed',
      'private debt': 'Private Debt / Mezzanine', 'mezzanine': 'Private Debt / Mezzanine', 'debt': 'Private Debt / Mezzanine',
      'infrastructure': 'Infrastructure / Real Assets', 'real assets': 'Infrastructure / Real Assets',
      'secondaries': 'Secondaries',
      'fund-of-funds': 'Fund-of-Funds / Multi-Manager', 'multi-manager': 'Fund-of-Funds / Multi-Manager',
      'multi-stage': 'Multi-Stage', 'stage agnostic': 'Stage Agnostic', 'all stages': 'Stage Agnostic'
    };

    // Helper to find the correct category from the maps
    const findCategory = (input, categoryMap, defaultVal) => {
      const inputLc = lc(input);
      for (const key in categoryMap) {
        if (inputLc.includes(key)) {
          return categoryMap[key];
        }
      }
      return defaultVal;
    };

    // Normalize user inputs before sending to Gemini
    const normalizedEntityType = findCategory(entityType, MAIN_TYPES, 'LP');
    const gpOrLpMap = normalizedEntityType === 'GP' ? GP_TYPES : LP_TYPES;
    const normalizedSubType = findCategory(subType, gpOrLpMap, subType || 'Other');
    const normalizedSector = findCategory(sector, SECTORS, 'Sector Agnostic');

    /* ─── NEW: Watertight Gemini Prompt ───────────────────────────────── */
    const PROMPT = `
      You are an expert financial data analyst. Your task is to find five investment firms and structure the data as a raw JSON array.
      Your entire response MUST be only the raw JSON array, starting with '[' and ending with ']'. Do NOT use markdown.

      Primary Search Criteria:
      - Firm Type (entityType): "${normalizedEntityType}"
      - Specific Type (subType): "${normalizedSubType}"
      - Sector Focus: "${normalizedSector}"
      - Geography: "${geo}"

      Follow these three steps meticulously for each firm:

      ---
      ### STEP 1: CLASSIFY FIRM TYPE (entityType & subType)
      Use these strict definitions to determine 'entityType' and 'subType'. You MUST choose from the provided lists.

      * **LP (Limited Partner):** Commits capital to external funds. Indicators: "Investor in funds," "allocates capital," pension/endowment assets.
          * **Allowed LP Subtypes:** Endowment Fund, Sovereign Wealth Fund, Bank, Insurance Company, University, Pension Fund, Economic Development Agency, Family Office, Foundation, Wealth Management Firm, HNI, Hedge Fund, Fund of Funds, Other.
      * **GP (General Partner):** Raises and manages investment funds. Indicators: Mentions "Fund I, II," management fees, carried interest, SEC filings.
          * **Allowed GP Subtypes:** Private Equity, Venture Capital, Angel Investors, Corporate Development Teams, Incubator, Small Business investment Companies (SBIC), Business Development Companies, Growth Equity Firms, Accelerator, Angel Group, Asset Management Firms, Angel Investment Fund, Other.
      * **Broker:** An intermediary arranging deals. Indicators: "Capital advisory," "placement agent," success-fee model.
      * **Other:** Professional services/advisory firms not managing capital.

      ---
      ### STEP 2: CAPTURE CORE COMPANY DETAILS
      Capture the following fields precisely:
      * **firmName:** The official legal name of the firm.
      * **address:** Full headquarters mailing address.
      * **country:** The country of the headquarters. Must contain "${geo}".
      * **website:** The official company website URL.
      * **companyLinkedIn:** The official company LinkedIn profile URL.
      * **about:** A 2-3 sentence, factual summary of the firm.
      * **investmentStrategy:** A detailed summary of their strategy, including AUM, target sectors, stages, check sizes, and geographic focus if available.

      ---
      ### STEP 3: CLASSIFY SECTOR & STAGE
      You MUST classify the firm's investment focus using only the lists below.

      * **Sector:** Assign a primary sector from this GICS-based list.
          * **Allowed Sectors:** Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Health Care, Financials, Information Technology, Communication Services, Utilities, Real Estate, Sector Agnostic.
      * **sectorDetails:** Quote the firm's specific niche (e.g., "AI in drug discovery," "B2B SaaS"). This is critical.
      * **Stage:** Assign all applicable stages from this list. If the firm's website is unclear, state "Stage Agnostic".
          * **Allowed Stages:** Pre-Seed / Incubation, Seed / Angel, Early VC (Series A), Mid VC (Series B–C), Late VC / Pre-IPO, Growth Equity, Buyout / Control, Special Situations / Distressed, Private Debt / Mezzanine, Infrastructure / Real Assets, Secondaries, Fund-of-Funds / Multi-Manager, Multi-Stage, Stage Agnostic.

      ---
      ### FINAL JSON STRUCTURE
      Return an array of 5 objects matching this exact structure. All keys must be present. 'contacts' must be an empty array.

      {
        "firmName": "...",
        "entityType": "${normalizedEntityType}",
        "subType": "...",
        "address": "...",
        "country": "...",
        "website": "...",
        "companyLinkedIn": "...",
        "about": "...",
        "investmentStrategy": "...",
        "sector": "...",
        "sectorDetails": "...",
        "stage": "...",
        "contacts": []
      }
    `;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
      })
    });

    if (!geminiRes.ok) throw new Error(`Gemini API Error: ${geminiRes.status}`);

    const gJson = await geminiRes.json();

    let firmsFromAI;
    try {
      const txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
      firmsFromAI = JSON.parse(txt);
      if (!Array.isArray(firmsFromAI)) throw new Error("Parsed data is not an array.");
    } catch (e) {
      console.error("Gemini JSON parse error:", e.message);
      return json({ error: 'Gemini returned invalid data.' }, 500);
    }

    /* ─── NEW: Post-processing and DB Insertion ────────────────── */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website, firm_name, entity_type, sub_type, address, country, company_linkedin, about, investment_strategy,
       sector, sector_details, stage, source, validated, contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')
    `);

    const newFirms = [];
    for (const f of firmsFromAI) {
      if (!f.website || !f.firmName) continue;

      // Final normalization of Gemini's output before inserting
      const finalEntityType = findCategory(f.entityType, MAIN_TYPES, normalizedEntityType);
      const finalSubType = findCategory(f.subType, finalEntityType === 'GP' ? GP_TYPES : LP_TYPES, 'Other');
      const finalSector = findCategory(f.sector, SECTORS, 'Sector Agnostic');
      const finalStage = findCategory(f.stage, STAGES, 'Stage Agnostic');

      const res = await stmt.bind(
        f.website.trim(), f.firmName.trim(), finalEntityType, finalSubType,
        f.address || 'N/A', f.country || geo, f.companyLinkedIn || 'N/A',
        f.about || 'N/A', f.investmentStrategy || 'N/A',
        finalSector, f.sectorDetails || 'N/A', finalStage,
      ).run();

      if (res.meta.changes) {
        newFirms.push({
          id: res.meta.last_row_id, validated: false, source: 'Gemini', contacts: [], ...f,
          // overwrite with normalized values for immediate UI consistency
          entityType: finalEntityType, subType: finalSubType, sector: finalSector, stage: finalStage
        });
      }
    }

    return json({ added: newFirms.length, newFirms: newFirms });

  } catch (e) {
    console.error(e);
    return json({ error: String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
