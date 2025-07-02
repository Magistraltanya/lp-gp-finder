import { ensureTable } from './_ensureTable.js';

/**
 * POST /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added, newFirms:[{ … , id }] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;
    await ensureTable(DB);                     // ← one-liner schema guarantee

    /* ── parse + helpers ─────────────────── */
    const b = await request.json().catch(() => ({}));
    let { entityType="", subType="", sector="", geo="" } = b;
    const lc = s => (s||"").toLowerCase().trim();

    /* ── vocab maps ──────────────────────── */
    const TYPES = ["LP","GP","Broker","Other"];
    const LP = { "endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank","insurance":"Insurance Company",
                 "university":"University","pension":"Pension Fund","economic development":"Economic Development Agency",
                 "family":"Family Office","foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI",
                 "hedge":"Hedge Fund","fund of funds":"Fund of Funds" };
    const GP = { "private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital","vc":"Venture Capital",
                 "angel":"Angel Investors","corporate":"Corporate Development Team","cvc":"Corporate Development Team",
                 "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
                 "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group",
                 "asset":"Asset Management Firm","angel fund":"Angel Investment Fund" };
    const SECTOR = { "energy":"Energy","materials":"Materials","industrials":"Industrials",
                     "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples",
                     "health":"Health Care","healthcare":"Health Care",
                     "financial":"Financials","fin":"Financials",
                     "information technology":"Information Technology","it":"Information Technology","tech":"Information Technology",
                     "communication":"Communication Services","utilities":"Utilities","real estate":"Real Estate",
                     "sector agnostic":"Sector Agnostic" };

    /* ── normalise input ─────────────────── */
    entityType = TYPES.find(t=>lc(t)===lc(entityType)) || "LP";
    if(entityType==="LP"){
      const k=Object.keys(LP).find(k=>lc(subType).includes(k)); subType=k?LP[k]:"Other";
    }else if(entityType==="GP"){
      const k=Object.keys(GP).find(k=>lc(subType).includes(k)); subType=k?GP[k]:"Other";
    }else subType="Other";
    {const k=Object.keys(SECTOR).find(k=>lc(sector).includes(k)); sector=k?SECTOR[k]:"Sector Agnostic";}
    if(!geo) return json({ error:"geo is required" },400);

    /* ── Gemini prompt ───────────────────── */
    const PROMPT = `
Return ONLY a JSON array (no markdown) of exactly 5 firms.
If a field is unknown write "N/A" (never leave empty).

Required keys:
firmName · entityType · subType · address · country · website · companyLinkedIn · about · investmentStrategy · sector · sectorDetails · stage · contacts

Constraints:
• entityType  = "${entityType}"
• subType     = "${subType}"
• sector      = "${sector}"
• country     contains "${geo}"
`;

    /* ── Gemini call (2 retries) ─────────── */
    const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    let gRes;
    for(let i=0;i<3;i++){
      gRes=await fetch(url,{method:"POST",headers:{'content-type':'application/json'},
        body:JSON.stringify({contents:[{role:"user",parts:[{text:PROMPT}]}],
                             generationConfig:{responseMimeType:"application/json"}})});
      if(gRes.ok)break;
      if(gRes.status>=500)await new Promise(r=>setTimeout(r,400*(i+1)));
      else throw new Error(`Gemini ${gRes.status}`);
    }

    const gJ=await gRes.json();
    let raw=gJ?.candidates?.[0]?.content?.parts?.[0]?.text||"[]";
    raw=raw.replace(/^```[a-z]*\s*/i,"").replace(/```$/,"").trim();

    let arr; try{arr=JSON.parse(raw); if(!Array.isArray(arr))throw 0;}
    catch{return json({ error:"Gemini bad JSON" },500);}

    /* ── insert (dedupe) ─────────────────── */
    const ins = await DB.prepare(
      `INSERT OR IGNORE INTO firms
       (website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,
        sector,sector_details,stage,source,validated,contacts_json)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0,'[]')`
    );

    let added=0, newRows=[];
    for(const x0 of arr){
      const x={                             // back-fill blanks
        firmName:x0.firmName||"N/A",
        entityType:x0.entityType!=="N/A" ? x0.entityType : entityType,
        subType:x0.subType!=="N/A" ? x0.subType : subType,
        address:x0.address||"N/A",
        country:x0.country||geo,
        website:x0.website||"N/A",
        companyLinkedIn:x0.companyLinkedIn||"N/A",
        about:x0.about||"N/A",
        investmentStrategy:x0.investmentStrategy||"N/A",
        sector:x0.sector!=="N/A"?x0.sector:sector,
        sectorDetails:x0.sectorDetails||"N/A",
        stage:x0.stage||"N/A"
      };
      const res=await ins.bind(
        x.website,x.firmName,x.entityType,x.subType,x.address,x.country,
        x.companyLinkedIn,x.about,x.investmentStrategy,x.sector,x.sectorDetails,x.stage
      ).run();
      if(res.meta.changes){
        newRows.push({ id:res.meta.last_row_id, validated:false, source:"Gemini", contacts:[], ...x });
        added++;
      }
    }

    return json({ added, newFirms:newRows });

  } catch (e) {
    console.error(e);
    return json({ error:String(e.message||e) },500);
  }
}

const json = (d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json'}});
