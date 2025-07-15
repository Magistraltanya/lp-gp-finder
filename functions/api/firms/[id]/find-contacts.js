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

/**
 * Step 2: Uses Tavily Search API to find a verified URL.
 */
async function searchForContactUrl(query, apiKey) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        max_results: 1,
        // We add the linkedin domain here to focus the search
        include_domains: ["linkedin.com"] 
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.results && data.results.length > 0 ? data.results[0].url : "";
  } catch (e) {
    console.error("Tavily search failed:", e);
    return "";
  }
}


export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY, TAVILY_KEY } = env;
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!TAVILY_KEY) {
      throw new Error("Tavily API key is not configured.");
    }

    await ensureContactsSourceColumn(DB);

    // Step 1: Use Gemini to get potential names and titles.
    const PROMPT_NAMES = `Your task is to identify the names and titles of up to two key decision-makers (e.g., CEO, Founder, Partner) for the company "${firmName}" (${website}). Return ONLY a raw JSON array of objects with "contactName" and "designation" keys.`;
    
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_NAMES }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
    });
    if (!geminiRes.ok) throw new Error(`Gemini API Error: ${geminiRes.statusText}`);
    const gJson = await geminiRes.json();
    const potentialContacts = JSON.parse(gJson.candidates[0].content.parts[0].text);

    let enrichedContacts = [];

    for (const contact of potentialContacts) {
      if (!contact.contactName || !contact.designation) continue;
      
      // [THE FIX] Using a more natural and effective search query.
      const searchQuery = `"${contact.contactName}" "${firmName}" LinkedIn`;
      const linkedInUrl = await searchForContactUrl(searchQuery, TAVILY_KEY);
      
      enrichedContacts.push({
        contactName: contact.contactName,
        designation: contact.designation,
        email: "",
        linkedIn: linkedInUrl,
        contactNumber: ""
      });
    }

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
