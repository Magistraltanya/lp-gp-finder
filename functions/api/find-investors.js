import { ensureTable } from './_ensureTable.js';



/**

 * Normalizes a URL string to a canonical form for de-duplication.

 */

function normalizeUrl(urlString) {

  if (!urlString || typeof urlString !== 'string') return '';

  try {

    let fullUrl = urlString.trim();

    if (!fullUrl.startsWith('http')) {

      fullUrl = 'https://' + fullUrl;

    }

    const url = new URL(fullUrl);

    let hostname = url.hostname;

    if (hostname.startsWith('www.')) {

      hostname = hostname.substring(4);

    }

    let path = url.pathname;

    if (path === '/') path = '';

    else if (path.endsWith('/')) path = path.slice(0, -1);

    

    return (hostname + path + url.search).toLowerCase();

  } catch (e) {

    return urlString.trim().toLowerCase()

      .replace(/^https?:\/\//, '')

      .replace(/^www\./, '')

      .replace(/\/$/, '');

  }

}



/**

 * POST /api/find-investors

 */

export async function onRequestPost({ request, env }) {

  try {

    const { DB, GEMINI_KEY } = env;

    await ensureTable(DB);



    // --- (Parameter parsing and vocab definitions are unchanged) ---

    const b = await request.json().catch(() => ({}));

    let { entityType = '', subType = '', sector = '', geo = '' } = b;

    const lc = s => (s || '').toLowerCase().trim();

    const TYPES = ['LP', 'GP', 'Broker', 'Other'];

    const LP = { 'endowment':'Endowment Fund','sovereign':'Sovereign Wealth Fund','bank':'Bank','insurance':'Insurance Company','university':'University','pension':'Pension Fund','economic development':'Economic Development Agency','family':'Family Office','foundation':'Foundation','wealth':'Wealth Management Firm','hni':'HNI','hedge':'Hedge Fund','fund of funds':'Fund of Funds' };

    const GP = { 'private equity':'Private Equity','pe':'Private Equity','venture capital':'Venture Capital','vc':'Venture Capital','angel':'Angel Investors','corporate':'Corporate Development Team','cvc':'Corporate Development Team','incubator':'Incubator','sbic':'SBIC','bdc':'Business Development Company','growth':'Growth Equity Firm','accelerator':'Accelerator','fof':'Fund of Funds','angel group':'Angel Group','asset':'Asset Management Firm','angel fund':'Angel Investment Fund' };

    const SECT = { 'energy':'Energy','materials':'Materials','industrials':'Industrials','consumer discretionary':'Consumer Discretionary','consumer staples':'Consumer Staples','health':'Health Care','healthcare':'Health Care','financial':'Financials','fin':'Financials','information technology':'Information Technology','it':'Information Technology','tech':'Information Technology','communication':'Communication Services','utilities':'Utilities','real estate':'Real Estate','sector agnostic':'Sector Agnostic' };

    entityType = TYPES.find(t => lc(t) === lc(entityType)) || 'LP';

    if (entityType === 'LP') { const k = Object.keys(LP).find(k => lc(subType).includes(k)); subType = k ? LP[k] : 'Other'; } else if (entityType === 'GP') { const k = Object.keys(GP).find(k => lc(subType).includes(k)); subType = k ? GP[k] : 'Other'; } else subType = 'Other';

    { const k = Object.keys(SECT).find(k => lc(sector).includes(k)); sector = k ? SECT[k] : 'Sector Agnostic'; }

    if (!geo) return json({ error: 'geo is required' }, 400);



    /* ── Gemini prompt [NEW - PROFESSIONAL & STRICT] ────── */

    const PROMPT = `

You are a high-accuracy data extraction AI. Your task is to find real investment firms and populate a JSON structure with verified, real-world data.



**Constraint Checklist (MUST be followed):**

1.  Return **exactly five (5)** investment firms matching the search criteria.

2.  **Placeholder text is strictly forbidden.** Do not use "unavailable", "N/A", "Not Disclosed", or similar phrases. Every JSON field must contain real data.

3.  **Verification is mandatory.** For each firm, you must simulate a search to find its official website and LinkedIn page to gather and confirm the information. All URLs must be valid and active.



**Search Criteria:**

* **Entity Type:** "${entityType}" (Synonyms: LP → Limited Partner, GP → General Partner)

* **Specific Type:** "${subType}" (Handle common abbreviations automatically: VC/V.C. → Venture Capital, PE → Private Equity, FO → Family Office, etc.

* **Sector Focus:** "${sector}"

* **Geography:** "${geo}"



**Output Format:**

Return ONLY a raw JSON array of five objects. Do not use markdown.

=== Instructions ===

1. Use authoritative, up-to-date public sources (official site ≫ LinkedIn ≫ news >> other secondary sources).  

2. Populate **every field** in the JSON schema; avoid placeholders like “N/A”.  

3. ‘website’ and ‘companyLinkedIn’ must be complete HTTPS URLs.  

4. Keep ‘about’ and ‘investmentStrategy’ concise yet specific (≤ 5 lines each).  

5. Think step-by-step internally but **output ONLY** the final JSON array—no markdown, code fences, or commentary.



**JSON Structure:**

[

  {

    "firmName": "The official, full name of the firm.",

    "entityType": "${entityType}",

    "subType": "${subType}",

    "address": "The firm's full, real physical address.",

    "country": "The country where the firm is located.",

    "website": "The valid, official website URL.",

    "companyLinkedIn": "The valid URL for the company's LinkedIn page.",

    "about": "A detailed 3-4 line summary of the firm, from its official sources.",

    "investmentStrategy": "A detailed 4-5 line summary of their investment thesis, including typical assets under management (AUM), check size, and investment focus.",

    "sector": "${sector}",

    "sectorDetails": "Specific sub-sectors of focus.",

    "stage": "The investment stage, e.g., 'Seed', 'Series A', 'Stage Agnostic'.",

    "contacts": []

  }

]

`;



    const url =

      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent' +

      `?key=${GEMINI_KEY}`;



    /* ── Gemini call [NEW - Resilient Retry Logic] ─────── */

    let res;

    for (let i = 0; i < 3; i++) {

      res = await fetch(url, {

        method : 'POST',

        headers: { 'content-type':'application/json' },

        body   : JSON.stringify({

          contents: [{ role:'user', parts:[{ text:PROMPT }] }],

          generationConfig : { responseMimeType:'application/json', temperature: 0.6 }

        })

      });



      if (res.ok) break;



      if (res.status === 429) {

        // Handle rate-limiting by waiting longer before retrying

        const waitTime = 2000 * (i + 1); // 2s, 4s, 6s

        await new Promise(r => setTimeout(r, waitTime));

      } else if (res.status >= 500) {

        // Handle server errors with a shorter wait

        await new Promise(r => setTimeout(r, 500 * (i + 1)));

      } else {

        // For other client errors (400, 401 etc.), fail immediately

        throw new Error(`Gemini request failed with status: ${res.status}`);

      }

    }



    // After the loop, if the response is still not OK, throw an error

    if (!res.ok) {

      throw new Error(`Gemini request failed after all retries with status: ${res.status}`);

    }



    const gJson = await res.json();

    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

    const startIndex = txt.indexOf('[');

    const endIndex = txt.lastIndexOf(']');

    if (startIndex === -1 || endIndex === -1) { console.error("Gemini Response Text:", txt); return json({ error: 'Gemini returned invalid data (no array found)' }, 500); }

    txt = txt.substring(startIndex, endIndex + 1);

    let arr;

    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw new Error("Response was not a JSON array."); } catch(e) { console.error("Gemini JSON Parse Error:", e.message, "Original Text:", txt); return json({ error:'Gemini bad JSON' }, 500); }



    const stmt = await DB.prepare(`

      INSERT OR IGNORE INTO firms

      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,

       sector,sector_details,stage,source,validated,contacts_json)

      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,?13)

    `);



    const out = [];

    for (const f of arr) {

      const firmName = (f.firmName || '').trim();

      if (!firmName) continue;



      const existing = await DB.prepare("SELECT id FROM firms WHERE firm_name = ?1").bind(firmName).first();

      if (existing) continue;



      const originalWebsite = (f.website || '').trim();

      const normalizedWebsite = normalizeUrl(originalWebsite);

      const contactsJson = JSON.stringify(f.contacts || []);

      

      const dbRes = await stmt.bind(

        normalizedWebsite, firmName, f.entityType.trim(), f.subType.trim(),

        f.address || 'N/A', f.country || geo,

        f.companyLinkedIn || 'N/A', f.about || 'N/A',

        f.investmentStrategy || 'N/A', f.sector || sector,

        f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic',

        contactsJson

      ).run();



      if (dbRes.meta.changes) {

        const firmForUi = { ...f };

        firmForUi.id = dbRes.meta.last_row_id;

        firmForUi.validated = false;

        firmForUi.source = 'Gemini';

        firmForUi.contacts = f.contacts || [];

        firmForUi.website = originalWebsite;

        out.push(firmForUi);

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
