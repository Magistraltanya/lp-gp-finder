import { ensureTable } from './_ensureTable.js';

/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Return: { added, newFirms:[ rowObjects … ] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    await ensureTable(DB);

    /* ── parse body & lowercase helper ─────────────────── */
    const b = await request.json().catch(() => ({}));
    let { entityType = '', subType = '', sector = '', geo = '' } = b;
    const lc = s => (s || '').toLowerCase().trim();

    /* ── fixed vocab maps ──────────────────────────────── */
    const TYPES = ['LP', 'GP', 'Broker', 'Other'];
    const LP = {
      'endowment':'Endowment Fund','sovereign':'Sovereign Wealth Fund','bank':'Bank',
      'insurance':'Insurance Company','university':'University','pension':'Pension Fund',
      'economic development':'Economic Development Agency','family':'Family Office',
      'foundation':'Foundation','wealth':'Wealth Management Firm','hni':'HNI',
      'hedge':'Hedge Fund','fund of funds':'Fund of Funds'
    };
    const GP = {
      'private equity':'Private Equity','pe':'Private Equity',
      'venture capital':'Venture Capital','vc':'Venture Capital',
      'angel':'Angel Investors','corporate':'Corporate Development Team','cvc':'Corporate Development Team',
      'incubator':'Incubator','sbic':'SBIC','bdc':'Business Development Company',
      'growth':'Growth Equity Firm','accelerator':'Accelerator','fof':'Fund of Funds',
      'angel group':'Angel Group','asset':'Asset Management Firm','angel fund':'Angel Investment Fund'
    };
    const SECT = {
      'energy':'Energy','materials':'Materials','industrials':'Industrials',
      'consumer discretionary':'Consumer Discretionary','consumer staples':'Consumer Staples',
      'health':'Health Care','healthcare':'Health Care',
      'financial':'Financials','fin':'Financials',
      'information technology':'Information Technology','it':'Information Technology','tech':'Information Technology',
      'communication':'Communication Services','utilities':'Utilities','real estate':'Real Estate',
      'sector agnostic':'Sector Agnostic'
    };

    /* ── normalise parameters ──────────────────────────── */
    entityType = TYPES.find(t => lc(t) === lc(entityType)) || 'LP';
    if (entityType === 'LP') {
      const k = Object.keys(LP).find(k => lc(subType).includes(k));
      subType = k ? LP[k] : 'Other';
    } else if (entityType === 'GP') {
      const k = Object.keys(GP).find(k => lc(subType).includes(k));
      subType = k ? GP[k] : 'Other';
    } else subType = 'Other';

    { const k = Object.keys(SECT).find(k => lc(sector).includes(k));
      sector = k ? SECT[k] : 'Sector Agnostic'; }

    if (!geo) return json({ error: 'geo is required' }, 400);

    /* ── Gemini prompt [IMPROVED] ─────────────────────────────────── */
    const PROMPT = `
You are a top-tier investment analyst researcher. Your task is to identify exactly five (5) investment firms based on the following criteria. Your results must be real, verifiable firms.

**Search Criteria:**
* **Entity Type:** "${entityType}"
* **Specific Type:** "${subType}"
* **Sector Focus:** "${sector}"
* **Geography:** "${geo}"

**Output Format:**
Return a single, raw JSON array of objects. Do NOT use markdown formatting (like \`\`\`json). The response must be ONLY the JSON array. Each object must have the exact keys below. If a value cannot be found, use the string "Not Disclosed".

**JSON Structure Example:**
[
  {
    "firmName": "Example Ventures",
    "entityType": "${entityType}",
    "subType": "${subType}",
    "address": "123 Innovation Drive, Silicon Valley, CA 94043, USA",
    "country": "USA",
    "website": "https://www.exampleventures.com",
    "companyLinkedIn": "https://linkedin.com/company/example-ventures",
    "about": "A brief, one-sentence description of the firm.",
    "investmentStrategy": "A concise summary of their investment thesis and focus.",
    "sector": "${sector}",
    "sectorDetails": "Specific niches within the main sector, e.g., 'SaaS, AI/ML'.",
    "stage": "e.g., 'Seed', 'Series A', 'Growth', 'Stage Agnostic'",
    "contacts": [
      {
        "contactName": "Jane Doe",
        "designation": "Managing Partner",
        "email": "Not Disclosed",
        "linkedIn": "https://linkedin.com/in/janedoe-investor"
      }
    ]
  }
]
`;

    /* ── Gemini call with simple retry ─────────────────── */
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent' +
      `?key=${GEMINI_KEY}`;

    let res;
    for (let i = 0; i < 3; i++) {
      res = await fetch(url, {
        method : 'POST',
        headers: { 'content-type':'application/json' },
        body   : JSON.stringify({
          contents: [{ role:'user', parts:[{ text:PROMPT }] }],
          generationConfig : { responseMimeType:'application/json', temperature: 0.2 }
        })
      });
      if (res.ok) break;
      if (res.status >= 500) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      else throw new Error(`Gemini ${res.status}`);
    }

    /* ── Robust JSON parsing [IMPROVED] ─────────────────── */
    const gJson = await res.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

    // Find the start and end of the array to make parsing more reliable
    const startIndex = txt.indexOf('[');
    const endIndex = txt.lastIndexOf(']');

    if (startIndex === -1 || endIndex === -1) {
      console.error("Gemini Response Text:", txt);
      return json({ error: 'Gemini returned invalid data (no array found)' }, 500);
    }

    txt = txt.substring(startIndex, endIndex + 1);

    let arr;
    try {
        arr = JSON.parse(txt);
        if (!Array.isArray(arr)) throw new Error("Response was not a JSON array.");
    }
    catch(e) {
        console.error("Gemini JSON Parse Error:", e.message, "Original Text:", txt);
        return json({ error:'Gemini bad JSON' }, 500);
    }

    /* ── insert (now with contacts) [IMPROVED] ─────────── */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,?13)
    `);

    const out = [];
    for (const f of arr) {
      if (!(f.website && f.firmName)) continue;

      // Use the contacts array provided by the AI
      const contactsJson = JSON.stringify(f.contacts || []);

      const res = await stmt.bind(
        f.website.trim(), f.firmName.trim(), f.entityType.trim(), f.subType.trim(),
        f.address || 'N/A', f.country || geo,
        f.companyLinkedIn || 'N/A', f.about || 'N/A',
        f.investmentStrategy || 'N/A', f.sector || sector,
        f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic',
        contactsJson
      ).run();

      if (res.meta.changes) {
        out.push({
          id: res.meta.last_row_id,
          validated: false,
          source: 'Gemini',
          contacts: f.contacts || [], // Pass the array to the front-end
          ...f
        });
      }
    }

    return json({ added: out.length, newFirms: out });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
