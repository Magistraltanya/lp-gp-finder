export async function ensureTable(DB){
  const info = await DB.prepare(`PRAGMA table_info(firms)`).all().catch(()=>({results:[]}));
  if(info.results.length){
    const has = info.results.some(c=>c.name==="contacts_json");
    if(!has) try{await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT DEFAULT '[]'`);}catch{}
    return;
  }
  await DB.exec(`
    CREATE TABLE firms(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website TEXT UNIQUE,
      firm_name TEXT,
      entity_type TEXT,
      sub_type TEXT,
      address TEXT,
      country TEXT,
      company_linkedin TEXT,
      about TEXT,
      investment_strategy TEXT,
      sector TEXT,
      sector_details TEXT,
      stage TEXT,
      source TEXT,
      validated INTEGER DEFAULT 0,
      contacts_json TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_firms_web ON firms(website);
  `);
}
