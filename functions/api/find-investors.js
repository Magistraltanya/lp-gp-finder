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

    /* ── Gemini prompt ─────────────────────────────────── */
    const PROMPT = `
Return **exactly five (5)** firms strictly as plain JSON (no markdown).
All keys below must be present and non-empty:

{
 firmName, entityType, subType, address, country, website, companyLinkedIn,
 about, investmentStrategy, sector, sectorDetails, stage, contacts:[]
}

Constraints (MUST hold for every object):
  entityType  = "${entityType}"
  subType     = "${subType}"
  sector      = "${sector}"
  country     contains "${geo}"

Use exactly the spellings given in the allowed lists.
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
          generationConfig : { responseMimeType:'application/json' }
        })
      });
      if (res.ok) break;
      if (res.status >= 500) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      else throw new Error(`Gemini ${res.status}`);
    }

    const gJson = await res.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    txt = txt
      .replace(/^```[\s\S]*?\n/, '')   // leading ```lang
      .replace(/```$/, '')             // trailing fence
      .replace(/,\s*}/g, '}')          // trailing commas
      .replace(/,\s*]/g, ']')
      .trim();

    let arr;
    try { arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0; }
    catch { return json({ error:'Gemini bad JSON' }, 500); }

    /* ── insert ───────────────────────────────────────── */
    const stmt = await DB.prepare(`
      INSERT OR IGNORE INTO firms
      (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
       sector,sector_details,stage,source,validated,contacts_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')
    `);

    const out = [];
    for (const f of arr) {
      if (!(f.website && f.firmName)) continue;   // must have unique key

      const res = await stmt.bind(
        f.website.trim(), f.firmName.trim(), f.entityType.trim(), f.subType.trim(),
        f.address || 'N/A', f.country || geo,
        f.companyLinkedIn || 'N/A', f.about || 'N/A',
        f.investmentStrategy || 'N/A', f.sector || sector,
        f.sectorDetails || 'Niche not stated', f.stage || 'Stage Agnostic'
      ).run();

      if (res.meta.changes)
        out.push({ id: res.meta.last_row_id, validated:false, source:'Gemini', contacts:[], ...f });
    }

    return json({ added: out.length, newFirms: out });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message || e) }, 500);
  }
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status:s, headers:{ 'content-type':'application/json' } });
