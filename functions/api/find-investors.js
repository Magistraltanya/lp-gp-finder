/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Returns: { added , newFirms:[ { … , id:<number>} ] }
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY, DB } = env;
    const b = await request.json().catch(() => ({}));
    let { entityType = "", subType = "", sector = "", geo = "" } = b;

    /* —— normalisation (same code you already had) —— */
    const ETYPES=["LP","GP","Broker","Other"];
    /* ... LP/GP/SECTOR maps unchanged ... */
    const lc=s=>s.toLowerCase().trim();
    entityType=ETYPES.find(t=>lc(t)===lc(entityType))||"LP";
    /* ... exactly the same mapping logic ... */

    /* —— Gemini prompt and call (unchanged) —— */
    /*  ... PROMPT building & callGemini() identical ... */

    const gRes   = await callGemini(PROMPT);
    const gJson  = await gRes.json();
    const raw    = gJson?.candidates?.[0]?.content?.parts?.[0]?.text||"[]";
    let firmsAI  = JSON.parse(raw);

    /* —— create table if missing —— */
    await DB.exec(`CREATE TABLE IF NOT EXISTS firms(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website TEXT UNIQUE, firm_name TEXT, entity_type TEXT, sub_type TEXT,
      address TEXT, country TEXT, company_linkedin TEXT, about TEXT,
      investment_strategy TEXT, sector TEXT, sector_details TEXT,
      stage TEXT, source TEXT, validated INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP );`);

    /* —— insert rows, return id —— */
    let added=0; const newFirms=[];
    const stmt=await DB.prepare(
      `INSERT INTO firms (website,firm_name,entity_type,sub_type,address,country,
                          company_linkedin,about,investment_strategy,
                          sector,sector_details,stage,source,validated)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'Gemini',0)`);
    for(const f of firmsAI){
      const key=(f.website||f.firmName||"").toLowerCase();
      if(!key)continue;
      const dup=await DB.prepare("SELECT id FROM firms WHERE website=? LIMIT 1").bind(key).first();
      if(dup)continue;

      const res=await stmt.bind(
        f.website||"",f.firmName||"",f.entityType||entityType,f.subType||subType,
        f.address||"",f.country||geo,f.companyLinkedIn||"",f.about||"",f.investmentStrategy||"",
        f.sector||sector,f.sectorDetails||"",f.stage||""
      ).run();

      newFirms.push({ id:res.meta.last_row_id, validated:false, source:"Gemini", contacts:[], ...f });
      added++;
    }
    return json({ added, newFirms });
  } catch (err) {
    console.error("find-investors error:", err);
    return json({ error:String(err.message||err) },500);
  }
}
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json'}});
