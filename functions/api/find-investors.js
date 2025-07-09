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

    /* ── Gemini prompt [ANTI-HALLUCINATION] ────────── */
    const PROMPT = `
You are an expert financial researcher. Your primary goal is to provide real, verifiable, and up-to-date information. Do not invent or hallucinate data.

**Your Task:**
Identify **up to five (5)** investment firms matching the criteria below.

**Mandatory Research Process:**
1.  You must act as if you are performing real-time Google searches to find these firms.
2.  For each firm, you must verify the existence of their official website and LinkedIn page. The URLs must be active and correct.
3.  Prioritize information directly from the firm's official sources.

**Search Criteria:**
* **Entity Type:** "${entityType}"
* **Specific Type:** "${subType}"
* **Sector Focus:** "${sector}"
* **Geography:** "${geo}"

**Output Format:**
Return ONLY a raw JSON array. If you cannot find any real firms that match the criteria after a thorough search, return an empty array []. Do not invent firms to meet the five-firm quota.

**JSON Structure:**
[
  {
    "firmName": "The official, full name of the firm.",
    "entityType": "${entityType}",
    "subType": "${subType}",
    "address": "The firm's physical address.",
    "country": "The country where the firm is located.",
    "website": "The valid and active official website URL.",
    "companyLinkedIn": "The valid and active URL for the company's LinkedIn page.",
    "about": "A brief summary from the company's own 'About Us' page or LinkedIn profile.",
    "investmentStrategy": "A concise summary of their investment thesis from their official website.",
    "sector": "${sector}",
    "sectorDetails": "Specific sub-sectors of focus.",
    "stage": "The investment stage, e.g., 'Seed', 'Series A', 'Stage Agnostic'.",
    "contacts": [
      {
        "contactName": "Name of a key decision-maker (e.g., Partner, Managing Director).",
        "designation": "Their official title.",
        "email": "Their publicly listed professional email, if available.",
        "linkedIn": "A valid URL to their personal LinkedIn profile."
      }
    ]
  }
]
`;

    /* ── Gemini call [REVERTED TO FLASH MODEL] ─────────────────── */
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
          generationConfig : { responseMimeType:'application/json', temperature: 0.5 }
        })
      });
      if (res.ok) break;
      if (res.status >= 500) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      else throw new Error(`Gemini ${res.status}`);
    }

    // --- (JSON parsing and DB logic are unchanged) ---
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
      const originalWebsite = (f.website || '').trim();

      if (!firmName) continue;
      const existing = await DB.prepare("SELECT id FROM firms WHERE firm_name = ?1").bind(firmName).first();
      if (existing) continue;

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
