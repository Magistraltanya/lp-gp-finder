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

// A generic helper to call the Gemini API
async function callGemini(prompt, geminiKey, temperature = 0.1) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + geminiKey;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: temperature }
        })
    });
    if (!response.ok) throw new Error(`Gemini API Error: ${response.status} ${response.statusText}`);
    const gJson = await response.json();
    return JSON.parse(gJson.candidates[0].content.parts[0].text);
}

// A generic helper to call the Tavily Search API
async function tavilySearch(query, apiKey) {
    try {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, query: query, search_depth: 'advanced', max_results: 3 }),
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.results || [];
    } catch (e) {
        console.error("Tavily search failed:", e);
        return [];
    }
}


export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY, TAVILY_KEY } = env;
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!TAVILY_KEY) throw new Error("Tavily API key is not configured.");
    await ensureContactsSourceColumn(DB);

    // STEP 1: Use the "Search Strategist" AI to generate smart search queries.
    const PROMPT_QUERIES = `You are a research analyst. Generate a JSON array of 3 diverse and effective Google search queries to find the key executives, partners, or board members for the company "${firmName}".
    Example output: ["'${firmName}' leadership team", "'${firmName}' board of directors", "site:linkedin.com '${firmName}' CEO OR Founder"]`;
    const searchQueries = await callGemini(PROMPT_QUERIES, GEMINI_KEY, 0.5);

    // STEP 2: Use the "Investigator" (Tavily) to execute all queries and gather research.
    let searchContext = "";
    for (const query of searchQueries) {
        const results = await tavilySearch(query, TAVILY_KEY);
        if (results.length > 0) {
            searchContext += `Results for query "${query}":\n` + results.map(r => `URL: ${r.url}\nContent: ${r.content}`).join('\n---\n');
            searchContext += '\n\n';
        }
    }

    if (searchContext.trim() === "") {
        throw new Error("Failed to find any information online for this company.");
    }
    
    // STEP 3: Use the "Data Extractor" AI to analyze the research and pull out contacts.
    const PROMPT_EXTRACT = `
Based *only* on the provided search results context below, identify up to two of the most senior key decision-makers for "${firmName}".

**CRITICAL INSTRUCTIONS:**
1.  Extract the Person's Name, Designation, and a direct, personal LinkedIn Profile URL.
2.  Your answer **MUST** come from the provided text. Do not use your own knowledge.
3.  The LinkedIn URL must be a full, valid URL containing "/in/". If no valid profile URL is found in the text, you **MUST** use an empty string "".
4.  Do not invent any data.

**SEARCH RESULTS CONTEXT:**
"""
${searchContext}
"""

**JSON OUTPUT (Return ONLY the raw JSON array):**
[
    {
      "contactName": "...",
      "designation": "...",
      "linkedIn": "...",
      "email": "",
      "contactNumber": ""
    }
]
`;
    const newContacts = await callGemini(PROMPT_EXTRACT, GEMINI_KEY, 0.0);

    // Final step: Update the database with the verified contacts.
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
