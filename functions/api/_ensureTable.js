export async function ensureTable(DB){
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
  
  const schema = await DB.prepare(`PRAGMA table_info(firms)`).all();
  const columns = new Set(schema.results.map(c => c.name));

  const columnsToAdd = [
    { name: 'philosophy', type: 'TEXT' },
    { name: 'aum', type: 'TEXT' },
    { name: 'check_size', type: 'TEXT' },
    { name: 'news_json', type: 'TEXT' }
  ];

  for (const col of columnsToAdd) {
    if (!columns.has(col.name)) {
      try {
        await DB.exec(`ALTER TABLE firms ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        console.error(`Failed to add column ${col.name}:`, e.message);
      }
    }
  }
}
