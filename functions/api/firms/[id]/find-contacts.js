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
 * [UPGRADED] Tries multiple queries to find the best possible context.
 */
async function getContextFromSearch(queries, apiKey) {
  for (const query of queries) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: query,
          search_depth: "advanced",
          max_results: 5,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          // Found good results, return the combined content
          return data.results.map(res => `Source URL: ${res.url}\nContent: ${res.content}`).join('\n\n---\n\n');
        }
      }
      // If response not ok or no results, loop will continue to the next query
    } catch (e) {
      console.error(`Tavily search failed for query "${query}":`, e);
      // Continue to the next query
    }
  }
  return "No valid search results found after trying multiple queries.";
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

    // [NEW] Define a series of queries to try in order of specificity.
    const searchQueries = [
      `Who are the key people, board members, or partners at "${firmName}"?`,
      `executive leadership team of "${firmName}" from their official website`,
      `"${firmName}" management team`,
      `about "${firmName}" company leadership`
    ];
    
    // Step 1: Use the "Investigator" (Tavily) to get raw context from the live internet.
    const searchContext = await getContextFromSearch(searchQueries, TAVILY_KEY);

    // Step 2: Use the "Extractor" (Gemini) to process the real data.
    const PROMPT_EXTRACT = `
You are a data extraction specialist. Based *only* on the provided search results context below, identify up to two key decision-makers for "${firmName}".

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
