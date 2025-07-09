// functions/api/_ensureTable.js
export async function ensureTable(DB){
  // Create the 'firms' table if it doesn't exist
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS firms(
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

  // Create an index on the 'website' column for faster lookups
  await DB.exec(`CREATE INDEX IF NOT EXISTS idx_firms_web ON firms(website);`);

  // Create the new cache table
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS gemini_cache(
      query_hash TEXT PRIMARY KEY,
      response TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // This ALTER TABLE logic is for backwards compatibility if the column was missing.
  // We can check and add it if needed.
  try {
    await DB.prepare(`SELECT contacts_json FROM firms LIMIT 1`).run();
  } catch (e) {
    if (e.message.includes('no such column')) {
      try {
        await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_json TEXT DEFAULT '[]'`);
      } catch (alterError) {
        console.error("Failed to alter table:", alterError);
      }
    }
  }
}
