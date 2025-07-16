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
 * Performs a detailed search using Tavily to get context.
 */
async function getContextFromSearch(query, apiKey) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "advanced", // Use advanced search for better context
        max_results: 5,
      }),
    });
    if (!response.ok) return "No search results found.";
    const data = await response.json();
    // Combine the content of all search results into a single context block
    return data.results.map(res => `Source URL: ${res.url}\nContent: ${res.content}`).join('\n\n---\n\n');
  } catch (e) {
    console.error("Tavily search failed:", e);
    return `Search failed: ${e.message}`;
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

    // Step 1: Use the "Investigator" (Tavily) to get raw context from the live internet.
    const searchQuery = `Who are the key people, founders, CEO, or partners at "${firmName}"?`;
    const searchContext = await getContextFromSearch(searchQuery, TAVILY_KEY);

    // Step 2: Use the "Extractor" (Gemini) to process the real data.
    const PROMPT_EXTRACT = `
You are a data extraction specialist. Based *only* on the provided search results below, identify up to two key decision-makers for "${firmName}".

**CRITICAL INSTRUCTIONS:**
1.  Extract the Person's Name, Designation, a direct LinkedIn Profile URL, an Email, and a Phone Number.
2.  Your answer **MUST** come from the provided text. Do not use your own knowledge or invent information.
3.  The LinkedIn URL must be a full, valid URL found in the text.
4.  If a specific detail (like email or phone) is not present in the text for a person, you **MUST** use an empty string "".

**SEARCH RESULTS CONTEXT:**
"""
${searchContext}
"""

**JSON OUTPUT:**
Return ONLY a raw JSON array with the extracted contacts.
`;
    
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_EXTRACT }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.0 } })
    });

    if (!geminiRes.ok) { throw new Error(`Gemini API Error: ${geminiRes.statusText}`); }

    const gJson = await geminiRes.json();
    const newContacts = JSON.parse(gJson.candidates[0].content.parts[0].text);

    if (!Array.isArray(newContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    // Filter out any empty results before saving
    const verifiedNewContacts = newContacts.filter(c => c.contactName && c.contactName !== "...");

    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    const mergedContacts = [...existingContacts, ...verifiedNewContacts];

    await DB.prepare(`UPDATE firms SET contacts_json = ?1, contacts_source = 'Gemini' WHERE id = ?2`)
      .bind(JSON.stringify(mergedContacts), id).run();

    return new Response(JSON.stringify({ contacts: mergedContacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Find Contacts Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
