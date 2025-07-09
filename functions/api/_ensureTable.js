// A separate, safe function to set up the main `firms` table
async function ensureFirmsTable(DB) {
  // Check if the 'firms' table already exists using the original, safe logic.
  const info = await DB.prepare(`PRAGMA table_info(firms)`).all().catch(() => ({ results: [] }));

  // If the table already exists, we're done with it.
  if (info.results.length > 0) {
    return;
  }

  // If the table does NOT exist, create it from scratch.
  // This will only run once when the database is first created.
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

// A separate function to ensure the cache table exists.
async function ensureCacheTable(DB) {
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS gemini_cache(
      query_hash TEXT PRIMARY KEY,
      response TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// The main export function that runs both setup functions.
export async function ensureTable(DB) {
  await ensureFirmsTable(DB);
  await ensureCacheTable(DB);
}
