/**
 * POST  /api/find-investors
 * Body  : { entityType, subType, sector, geo }
 * Return: { added, newFirms:[ { … , id } ] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;
    const b = await request.json().catch(()=>({}));
    let { entityType="", subType="", sector="", geo="" } = b;
    const lc=s=>s.toLowerCase().trim();

    /* —— normalise (same mappings you had) —— */
    const ETYPES=["LP","GP","Broker","Other"];
    const LP={"endowment":"Endowment Fund","sovereign":"Sovereign Wealth Fund","bank":"Bank","insurance":"Insurance Company",
      "university":"University","pension":"Pension Fund","economic development":"Economic Development Agency",
      "family":"Family Office","foundation":"Foundation","wealth":"Wealth Management Firm","hni":"HNI","hedge":"Hedge Fund",
      "fund of funds":"Fund of Funds"};
    const GP={"private equity":"Private Equity","pe":"Private Equity","venture capital":"Venture Capital","vc":"Venture Capital",
      "angel":"Angel Investors","corporate":"Corporate Development Team","cvc":"Corporate Development Team",
      "incubator":"Incubator","sbic":"SBIC","bdc":"Business Development Company","growth":"Growth Equity Firm",
      "accelerator":"Accelerator","fof":"Fund of Funds","angel group":"Angel Group","asset":"Asset Management Firm",
      "angel fund":"Angel Investment Fund"};
    const SECT={"energy":"Energy","materials":"Materials","industrials":"Industrials",
      "consumer discretionary":"Consumer Discretionary","consumer staples":"Consumer Staples","health":"Health Care",
      "healthcare":"Health Care","financial":"Financials","fin":"Financials","information technology":"Information Technology",
      "it":"Information Technology","tech":"Information Technology","communication":"Communication Services",
      "utilities":"Utilities","real estate":"Real Estate","sector agnostic":"Sector Agnostic"};

    entityType=ETYPES.find(t=>lc(t)==lc(entityType))||"LP";
    if(entityType==="LP"){const k=Object.keys(LP).find(k=>lc(subType).includes(k));subType=k?LP[k]:"Other";}
    else if(entityType==="GP"){const k=Object.keys(GP).find(k=>lc(subType).includes(k));subType=k?GP[k]:"Other";}
    else subType="Other";
    {const k=Object.keys(SECT).find(k=>lc(sector).includes(k));sector=k?SECT[k]:"Sector Agnostic";}
    if(!geo)return json({error:"geo is required"},400);

    /* —— Gemini prompt —— */
    const PROMPT=`Find 5 firms (JSON only) matching Entity="${entityType}", SubType="${subType}", Sector="${sector}", Country="${geo}".`;

    /* —— call Gemini (simple, retry 2×) —— */
    const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    let gemRes;
    for(let i=0;i<3;i++){
      gemRes=await fetch(url,{method:"POST",headers:{'content-type':'application/json'},
        body:JSON.stringify({contents:[{role:"user",parts:[{text:PROMPT}]}],generationConfig:{responseMimeType:"application/json"}})});
      if(gemRes.ok)break;
      if(gemRes.status>=500)await new Promise(r=>setTimeout(r,300*(i+1)));else throw new Error(`Gemini ${gemRes.status}`);
    }
    const gemJson=await gemRes.json();
    const raw=gemJson?.candidates?.[0]?.content?.parts?.[0]?.text||"[]";
    let arr;try{arr=JSON.parse(raw);if(!Array.isArray(arr))throw 0;}catch{return json({error:"Gemini bad JSON"},500);}

    /* —— make sure table exists (one-liner) —— */
    await DB.exec(`CREATE TABLE IF NOT EXISTS firms(id INTEGER PRIMARY KEY AUTOINCREMENT,website TEXT UNIQUE,firm_name TEXT,entity_type TEXT,sub_type TEXT,address TEXT,country TEXT,company_linkedin TEXT,about TEXT,investment_strategy TEXT,sector TEXT,sector_details TEXT,stage TEXT,source TEXT,validated INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

    /* —— insert rows —— */
    const stmt=await DB.prepare(`INSERT INTO firms(website,firm_name,entity_type,sub_type,address,country,company_linkedin,about,investment_strategy,sector,sector_details,stage,source,validated) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0)`);
    let added=0,newFirms=[];
    for(const f of arr){
      const key=(f.website||f.firmName||"").toLowerCase();if(!key)continue;
      const dup=await DB.prepare("SELECT id FROM firms WHERE website=? LIMIT 1").bind(key).first();if(dup)continue;
      const res=await stmt.bind(
        f.website||"",f.firmName||"",f.entityType||entityType,f.subType||subType,f.address||"",f.country||geo,
        f.companyLinkedIn||"",f.about||"",f.investmentStrategy||"",f.sector||sector,f.sectorDetails||"",f.stage||""
      ).run();
      newFirms.push({...f,id:res.meta.last_row_id,validated:false,source:"Gemini",contacts:[]});
      added++;
    }
    return json({added,newFirms});
  }catch(e){console.error(e);return json({error:String(e.message||e)},500);}
}
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json'}});
