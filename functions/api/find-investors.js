import { ensureTable } from './_ensureTable.js';

/**
 * Normalizes a URL string for de-duplication.
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

    // Cache table setup is isolated inside this function to prevent side effects.
    await DB.exec(`
      CREATE TABLE IF NOT EXISTS gemini_cache(
        query_hash TEXT PRIMARY KEY,
        response TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const b = await request.json().catch(() => ({}));
    const { entityType = '', subType = '', sector = '', geo = '' } = b;
    if (!geo) return json({ error: 'geo is required' }, 400);

    const cacheKey = `${entityType}|${subType}|${sector}|${geo}`.toLowerCase();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cached = await DB.prepare(
      "SELECT response FROM gemini_cache WHERE query_hash = ?1 AND timestamp > ?2"
    ).bind(cacheKey, oneHourAgo).first();

    if (cached) {
      const cachedFirms = JSON.parse(cached.response);
      return processFirms(cachedFirms, DB, { entityType, subType, sector, geo });
    }
    
    const systemInstruction = {
      role: 'system',
      parts: [{ text: `You are a high-accuracy data extraction API. Your only output is a single, raw JSON array. Do not use markdown or conversational text. The user will provide a JSON template with "..." as placeholders. Fill in these placeholders with real-world data and return the completed JSON.` }]
    };

    const PROMPT_TEMPLATE = `// Criteria: ${entityType}, ${subType}, ${sector}, ${geo}
[
  {"firmName": "...", "entityType": "${entityType}", "subType": "${subType}", "address": "...", "country": "${geo}", "website": "...", "companyLinkedIn": "...", "about": "...", "investmentStrategy": "...", "sector": "${sector}", "sectorDetails": "...", "stage": "..."},
  {"firmName": "...", "entityType": "${entityType}", "subType": "${subType}", "address": "...", "country": "${geo}", "website": "...", "companyLinkedIn": "...", "about": "...", "investmentStrategy": "...", "sector": "${sector}", "sectorDetails": "...", "stage": "..."},
  {"firmName": "...", "entityType": "${entityType}", "subType": "${subType}", "address": "...", "country": "${geo}", "website": "...", "companyLinkedIn": "...", "about": "...", "investmentStrategy": "...", "sector": "${sector}", "sectorDetails": "...", "stage": "..."},
  {"firmName": "...", "entityType": "${entityType}", "subType": "${subType}", "address": "...", "country": "${geo}", "website": "...", "companyLinkedIn": "...", "about": "...", "investmentStrategy": "...", "sector": "${sector}", "sectorDetails": "...", "stage": "..."},
  {"firmName": "...", "entityType": "${entityType}", "subType": "${subType}", "address": "...", "country": "${geo}", "website": "...", "companyLinkedIn": "...", "about": "...", "investmentStrategy": "...", "sector": "${sector}", "sectorDetails": "...", "stage": "..."}
]`;
    
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;
    
    let res;
    for (let i = 0; i < 3; i++) {
      res = await fetch(url, {
        method : 'POST',
        headers: { 'content-type':'application/json' },
        body   : JSON.stringify({ contents: [systemInstruction, { role: 'user', parts: [{ text: PROMPT_TEMPLATE }] }], generationConfig : { responseMimeType:'application/json', temperature: 0.6 } })
      });
      if (res.ok) break;
      if (res.status === 429) { const waitTime = 2500 * (i + 1); await new Promise(r => setTimeout(r, waitTime)); }
      else if (res.status >= 500) { await new Promise(r => setTimeout(r, 500 * (i + 1))); }
      else { throw new Error(`Gemini request failed with status: ${res.status}`); }
    }

    if (!res.ok) { throw new Error(`Gemini request failed after all retries with status: ${res.status}`); }

    const gJson = await res.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const startIndex = txt.indexOf('[');
    const endIndex = txt.lastIndexOf(']');
    if (startIndex === -1 || endIndex === '[]') { return json({ error: 'Gemini returned invalid data' }, 500); }
    txt = txt.substring(startIndex, endIndex + 1);
    let arr;
    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw new Error("Response was not a JSON array."); } catch(e) { return json({ error:'Gemini bad JSON' }, 500); }

    await DB.prepare("REPLACE INTO gemini_cache (query_hash, response) VALUES (?1, ?2)").bind(cacheKey, JSON.stringify(arr)).run();
    
    return processFirms(arr, DB, { entityType, subType, sector, geo });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message || e) }, 500);
  }
}

/**
 * Processes an array of firms, de-duplicates, and inserts them.
 */
async function processFirms(firmsArray, DB, criteria) {
  const stmt = await DB.prepare(`INSERT OR IGNORE INTO firms (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated,contacts_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')`);
  const out = [];

  for (const f of firmsArray) {
    const firmName = (f.firmName || '').trim();
    if (!firmName || firmName === "...") continue;

    const existing = await DB.prepare("SELECT id FROM firms WHERE firm_name = ?1").bind(firmName).first();
    if (existing) continue;

    const originalWebsite = (f.website || '').trim();
    const normalizedWebsite = normalizeUrl(originalWebsite);
    
    const dbRes = await stmt.bind(
      normalizedWebsite, firmName, f.entityType.trim(), f.subType.trim(),
      f.address || 'N/A', f.country || criteria.geo,
      f.companyLinkedIn || 'N/A', f.about || 'N/A',
      f.investmentStrategy || 'N/A', f.sector || criteria.sector,
      f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic'
    ).run();

    if (dbRes.meta.changes) {
      const firmForUi = { ...f, id: dbRes.meta.last_row_id, validated: false, source: 'Gemini', contacts: [], website: originalWebsite };
      out.push(firmForUi);
    }
  }
  return json({ added: out.length, newFirms: out });
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
