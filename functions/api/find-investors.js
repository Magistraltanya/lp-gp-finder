import { ensureTable } from './_ensureTable.js';

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

export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    await ensureTable(DB);

    const b = await request.json().catch(() => ({}));
    const { entityType = '', subType = '', sector = '', geo = '' } = b;
    if (!geo) return json({ error: 'geo is required' }, 400);

    const PROMPT = `You are a high-accuracy data extraction API. Your only output is a single, raw JSON array. Do not use markdown or conversational text. Your task is to find real-world investment firms based on the criteria below and fill in the "..." placeholders in the provided JSON template. Return only the completed JSON.

// Search Criteria:
// Entity Type: ${entityType}
// Specific Type: ${subType}
// Sector Focus: ${sector}
// Geography: ${geo}

// JSON Template to Complete:
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
        body   : JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
          generationConfig : { responseMimeType:'application/json', temperature: 0.6 }
        })
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
    if (startIndex === -1 || endIndex === -1) { return json({ error: 'Gemini returned invalid data' }, 500); }
    txt = txt.substring(startIndex, endIndex + 1);
    let arr;
    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw new Error("Response was not a JSON array."); } catch(e) { return json({ error:'Gemini bad JSON' }, 500); }
    
    const stmt = await DB.prepare(`INSERT OR IGNORE INTO firms (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated,contacts_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')`);
    const out = [];

    for (const f of arr) {
      const firmName = (f.firmName || '').trim();
      if (!firmName || firmName === "...") continue;

      const existing = await DB.prepare("SELECT id FROM firms WHERE firm_name = ?1").bind(firmName).first();
      if (existing) continue;

      const originalWebsite = (f.website || '').trim();
      const normalizedWebsite = normalizeUrl(originalWebsite);
      
      const dbRes = await stmt.bind(
        normalizedWebsite, firmName, f.entityType.trim(), f.subType.trim(),
        f.address || 'N/A', f.country || geo,
        f.companyLinkedIn || 'N/A', f.about || 'N/A',
        f.investmentStrategy || 'N/A', f.sector || sector,
        f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic'
      ).run();

      if (dbRes.meta.changes) {
        const firmForUi = { ...f, id: dbRes.meta.last_row_id, validated: false, source: 'Gemini', contacts: [], website: originalWebsite };
        out.push(firmForUi);
      }
    }
    return json({ added: out.length, newFirms: out });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
