import { ensureTable } from './_ensureTable.js';

export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    await ensureTable(DB);

    const b = await request.json().catch(() => ({}));
    let { entityType = '', subType = '', sector = '', geo = '' } = b;
    const lc = s => (s || '').toLowerCase().trim();

    // --- Expanded, canonical maps for normalization ---
    const MAIN_TYPES = { 'lp': 'LP', 'gp': 'GP', 'broker': 'Broker', 'other':'Other' };
    const LP_TYPES = {
        'endowment fund': 'Endowment Fund', 'sovereign wealth fund': 'Sovereign Wealth Fund',
        'bank': 'Bank', 'banks': 'Bank', 'insurance company': 'Insurance Company',
        'university': 'University', 'universities': 'University', 'pension fund': 'Pension Fund',
        'pension funds': 'Pension Fund', 'economic development agency': 'Economic Development Agency',
        'economic development agencies': 'Economic Development Agency', 'family office': 'Family Office',
        'foundation': 'Foundation', 'foundations': 'Foundation', 'wealth management firm': 'Wealth Management Firm',
        'hni': 'HNI', 'hedge fund': 'Hedge Fund', 'fund of funds': 'Fund-of-Funds'
    };
    const GP_TYPES = {
        'private equity': 'Private Equity', 'pe': 'Private Equity', 'venture capital': 'Venture Capital',
        'vc': 'Venture Capital', 'angel investors': 'Angel Investors', 'corporate development team': 'Corporate Development Team',
        'cvc': 'Corporate Development Team', 'incubator': 'Incubator', 'incubators': 'Incubator',
        'sbic': 'SBIC', 'small business investment company': 'SBIC', 'bdc': 'Business Development Company',
        'business development company': 'Business Development Company', 'growth equity firm': 'Growth Equity Firm',
        'growth equity': 'Growth Equity Firm', 'accelerator': 'Accelerator', 'fof': 'Fund-of-Funds',
        'fund of funds': 'Fund-of-Funds', 'angel group': 'Angel Group', 'asset management firm': 'Asset Management Firm',
        'asset management': 'Asset Management Firm', 'angel investment fund': 'Angel Investment Fund'
    };
    const SECTORS = {
        'energy': 'Energy', 'materials': 'Materials', 'industrials': 'Industrials',
        'consumer discretionary': 'Consumer Discretionary', 'consumer staples': 'Consumer Staples',
        'health': 'Health Care', 'healthcare': 'Health Care', 'financial': 'Financials', 'financials': 'Financials',
        'fintech': 'Financials', 'fin': 'Financials', 'information technology': 'Information Technology',
        'it': 'Information Technology', 'tech': 'Information Technology', 'communication': 'Communication Services',
        'communication services': 'Communication Services', 'utilities': 'Utilities', 'real estate': 'Real Estate',
        'sector agnostic': 'Sector Agnostic'
    };

    // --- Normalize parameters using the canonical maps ---
    entityType = MAIN_TYPES[lc(entityType)] || 'LP';

    if (entityType === 'LP') {
      subType = LP_TYPES[lc(subType)] || 'Family Office'; // Default to a common type
    } else if (entityType === 'GP') {
      subType = GP_TYPES[lc(subType)] || 'Private Equity';
    } else {
      subType = 'Other';
    }

    sector = SECTORS[lc(sector)] || 'Sector Agnostic';

    if (!geo) return json({ error: 'Geography is a required field' }, 400);

    // --- The new "Watertight" Gemini Prompt ---
    const PROMPT = `
      You are an expert financial data analyst. Your task is to find five investment firms based on the user's query and return the data as a single, raw JSON array.

      **CRITICAL RULES:**
      1.  **JSON ONLY:** The entire response MUST be a valid JSON array. Do NOT include \`\`\`json, explanations, or any text outside of the JSON array.
      2.  **EXACT LISTS:** You MUST use the exact spelling and capitalization for 'entityType', 'subType', 'sector', and 'stage' from the allowed values provided below.
      3.  **ALL FIELDS:** Every key in the JSON object must be present and contain a non-empty value. If you cannot find information for a field, state "Not Found". For 'contacts', return an empty array [].

      **Step 1: Classify the Firm Type**
      - **LP (Limited Partner):** Commits capital to external funds, does not manage daily investments. Indicators: "investor in funds," "allocates capital," pension/endowment assets.
      - **GP (General Partner):** Raises and manages funds, makes active investment decisions. Indicators: mentions of "Fund I, II", management fees, active portfolio.
      - **Broker:** Intermediary, placement agent, capital advisory. Does not manage capital.

      **Step 2: Find Core Details**
      - **firmName:** Official legal name.
      - **address:** Full mailing address of the headquarters.
      - **country:** Headquarters country.
      - **website:** The official, full website URL.
      - **companyLinkedIn:** The official LinkedIn URL for the company.
      - **about:** A concise 2-3 sentence summary of the firm.
      - **investmentStrategy:** Detailed strategy, including AUM, target sectors, stages, check size, and geographic focus.

      **Step 3: Determine Sector and Stage from ALLOWED LISTS ONLY**
      - **Sector:** Must be one of: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Health Care, Financials, Information Technology, Communication Services, Utilities, Real Estate, Sector Agnostic.
      - **sectorDetails:** Quote the firm's exact niche if specified (e.g., "SaaS within Information Technology").
      - **Stage:** Must be one of: Pre-Seed / Incubation, Seed / Angel, Early VC (Series A), Mid VC (Series B–C), Late VC / Pre-IPO, Growth Equity, Buyout / Control, Special Situations / Distressed, Private Debt / Mezzanine, Infrastructure / Real Assets, Secondaries, Fund-of-Funds / Multi-Manager, Multi-Stage, Stage Agnostic.

      **USER QUERY:**
      - **entityType:** "${entityType}"
      - **subType:** "${subType}"
      - **sector focus:** "${sector}"
      - **geography:** "${geo}"

      **OUTPUT FORMAT (JSON array of 5 objects):**
      [
        {
          "firmName": "...",
          "entityType": "${entityType}",
          "subType": "${subType}",
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
      ]
    `;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;

    let res;
    for (let i = 0; i < 3; i++) {
      res = await fetch(url, {
        method : 'POST',
        headers: { 'content-type':'application/json' },
        body   : JSON.stringify({
          contents         : [{ role:'user', parts:[{ text:PROMPT }] }],
          generationConfig : { responseMimeType:'application/json', temperature: 0.4 }
        })
      });
      if (res.ok) break;
      if (res.status >= 500) await new Promise(r => setTimeout(r, 500 * (i + 1)));
      else throw new Error(`Gemini API Error: ${res.status}`);
    }

    const gJson = await res.json();
    let arr;
    try {
      let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
      const startIndex = txt.indexOf('[');
      const endIndex = txt.lastIndexOf(']');
      if (startIndex === -1 || endIndex === -1) throw new Error("Response did not contain a JSON array.");
      const jsonString = txt.substring(startIndex, endIndex + 1);
      arr = JSON.parse(jsonString);
      if (!Array.isArray(arr)) throw new Error("Parsed data is not an array.");
    } catch(e) {
      console.error("Gemini JSON parse error:", e.message);
      return json({ error:'Gemini returned invalid data.' }, 500);
    }

    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')
    `);

    const out = [];
    for (const f of arr) {
      if (!(f.website && f.firmName)) continue;
      const runResult = await stmt.bind(
        f.website.trim(), f.firmName.trim(), f.entityType, f.subType,
        f.address, f.country, f.companyLinkedIn, f.about,
        f.investmentStrategy, f.sector, f.sectorDetails, f.stage
      ).run();
      if (runResult.meta.changes) {
        out.push({ id: runResult.meta.last_row_id, source:'Gemini', validated:false, ...f });
      }
    }

    return json({ added: out.length, newFirms: out });

  } catch (e) {
    console.error(e);
    return json({ error: String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers:{ 'content-type':'application/json' }});
