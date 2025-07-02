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

    /* ── Gemini prompt (IMPROVED) ────────────────────── */
    const PROMPT = `
      Generate a JSON array containing exactly five (5) objects.
      DO NOT use any markdown formatting (e.g., \`\`\`json).
      Your entire response must be only the raw JSON array, starting with '[' and ending with ']'.

      Each object must represent an investment firm with the following keys:
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
        "sector": "${sector}",
        "sectorDetails": "...",
        "stage": "...",
        "contacts": []
      }

      The following constraints MUST be met for every firm:
      - "entityType" must be exactly "${entityType}".
      - "subType" must be exactly "${subType}".
      - "sector" must be exactly "${sector}".
      - "country" must contain the substring "${geo}".
      - All string values must be non-empty.

      Return valid JSON only.
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
          contents         : [{ role:'user', parts:[{ text:PROMPT }] }],
          generationConfig : { responseMimeType:'application/json', temperature: 0.5 }
        })
      });
      if (res.ok) break;
      if (res.status >= 500) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      else throw new Error(`Gemini API Error: ${res.status}`);
    }

    const gJson = await res.json();
    
    /* ── Robust JSON Parsing (IMPROVED) ────────────────── */
    let arr;
    try {
      let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const startIndex = txt.indexOf('[');
      const endIndex = txt.lastIndexOf(']');
      if (startIndex === -1 || endIndex === -1) {
        throw new Error("Response did not contain a JSON array.");
      }
      const jsonString = txt.substring(startIndex, endIndex + 1);
      arr = JSON.parse(jsonString);
      if (!Array.isArray(arr)) throw new Error("Parsed data is not an array.");
    } catch(e) {
      console.error("Gemini JSON parse error:", e.message);
      console.error("Original Gemini response:", gJson?.candidates?.[0]?.content?.parts?.[0]?.text);
      return json({ error:'Gemini bad JSON' }, 500);
    }


    /* ── insert ───────────────────────────────────────── */
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
        f.website.trim(), f.firmName.trim(), f.entityType.trim(), f.subType.trim(),
        f.address || 'N/A', f.country || geo,
        f.companyLinkedIn || 'N/A', f.about || 'N/A',
        f.investmentStrategy || 'N/A', f.sector || sector,
        f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic'
      ).run();

      if (runResult.meta.changes)
        out.push({ id: runResult.meta.last_row_id, validated:false, source:'Gemini', contacts:[], ...f });
    }

    return json({ added: out.length, newFirms: out });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
