// functions/api/_ensureTable.js
export async function ensureTable(DB){
  // First, create the cache table if it doesn't exist. This is safe to run every time.
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS gemini_cache(
      query_hash TEXT PRIMARY KEY,
      response TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Now, use the original, safe logic for the 'firms' table.
  // Check if the 'firms' table already exists.
  const info = await DB.prepare(`PRAGMA table_info(firms)`).all().catch(()=>({results:[]}));

  if(info.results.length){
    // If the table exists, check if the 'contacts_json' column needs to be added (for old versions).
    const hasContactsColumn = info.results.some(c=>c.name==="contacts_json");
    if(!hasContactsColumn) {
      try {
        await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT DEFAULT '[]'`);
      } catch(e) {
        console.error("Failed to add contacts_json column", e);
      }
    }
    // IMPORTANT: Exit the function since the table is already set up.
    return;
  }

  // If the 'firms' table does NOT exist, create it from scratch.
  // This block will now only run ONCE during the initial setup.
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
  `);
  
  await DB.exec(`CREATE INDEX idx_firms_web ON firms(website);`);
}
