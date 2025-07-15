/**
 * Ensures the 'contacts_source' column exists in the firms table.
 */
async function ensureContactsSourceColumn(DB) {
  try {
    await DB.prepare(`SELECT contacts_source FROM firms LIMIT 1`).first();
  } catch (e) {
    if (e.message.includes('no such column')) {
      await DB.exec(`ALTER TABLE firms ADD COLUMN contacts_source TEXT`);
    }
  }
}

// Helper function to call the Tavily Search API
async function searchForContact(query, apiKey) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: "basic",
      include_domains: ["linkedin.com"],
      max_results: 1
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.results && data.results.length > 0 ? data.results[0] : null;
}


export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY, TAVILY_KEY } = env; // Assumes you've added TAVILY_KEY
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!TAVILY_KEY) {
      throw new Error("Tavily API key is not configured.");
    }

    await ensureContactsSourceColumn(DB);

    // STEP 1: Use Gemini as the "Researcher" to get potential names and titles.
    const PROMPT_NAMES = `Your task is to identify the names and titles of up to two key decision-makers (CEO, Founder, Partner) for the company "${firmName}" (${website}). Return ONLY a raw JSON array of objects with "contactName" and "designation" keys.`;
    
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_NAMES }] }], generationConfig: { responseMimeType: 'application/json' } })
    });
    if (!geminiRes.ok) throw new Error(`Gemini API Error: ${geminiRes.statusText}`);
    const gJson = await geminiRes.json();
    const potentialContacts = JSON.parse(gJson.candidates[0].content.parts[0].text);

    let enrichedContacts = [];

    // STEP 2: Use a real Search API as the "Investigator" to verify and find URLs.
    for (const contact of potentialContacts) {
      if (!contact.contactName) continue;
      
      const searchQuery = `"${contact.contactName}" "${contact.designation}" "${firmName}" site:linkedin.com/in`;
      const searchResult = await searchForContact(searchQuery, TAVILY_KEY);
      
      enrichedContacts.push({
        contactName: contact.contactName,
        designation: contact.designation,
        email: "", // Email finding is a separate, complex task
        // Use the REAL URL from the search result, or a blank string if none found.
        linkedIn: searchResult ? searchResult.url : "", 
        contactNumber: ""
      });
    }

    // STEP 3: Save the verified and enriched data.
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    const mergedContacts = [...existingContacts, ...enrichedContacts];

    await DB.prepare(`UPDATE firms SET contacts_json = ?1, contacts_source = 'Gemini' WHERE id = ?2`)
      .bind(JSON.stringify(mergedContacts), id).run();

    return new Response(JSON.stringify({ contacts: mergedContacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Find Contacts Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
