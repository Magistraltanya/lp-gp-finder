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
 * Step 2: Uses Tavily Search API to find a verified URL and page content.
 */
async function searchForContact(query, apiKey) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_raw_content: true,
        max_results: 1,
        include_domains: ["linkedin.com"]
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.results && data.results.length > 0 ? data.results[0] : null;
  } catch (e) {
    console.error("Tavily search failed:", e);
    return null;
  }
}

/**
 * Step 3: Uses Gemini to extract details from verified text.
 */
async function extractDetailsFromText(contactName, pageContent, geminiKey) {
  try {
    const PROMPT_EXTRACT = `From the following text, extract the email address and phone number for "${contactName}". Respond ONLY with a single raw JSON object: {"email": "...", "contactNumber": "..."}. If a value is not found in the text, use an empty string.

Text: """
${pageContent}
"""`;
    
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + geminiKey;
    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: PROMPT_EXTRACT }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.0 }
        })
    });
    if (!res.ok) return { email: "", contactNumber: "" };
    const gJson = await res.json();
    return JSON.parse(gJson.candidates[0].content.parts[0].text);
  } catch(e) {
    console.error("Gemini extraction failed:", e);
    return { email: "", contactNumber: "" };
  }
}


export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY, TAVILY_KEY } = env;
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!TAVILY_KEY) throw new Error("Tavily API key is not configured.");

    await ensureContactsSourceColumn(DB);

    const PROMPT_NAMES = `Your task is to identify the names and titles of up to two key decision-makers (e.g., CEO, Founder, Partner) for the company "${firmName}" (${website}). Return ONLY a raw JSON array of objects with "contactName" and "designation" keys.`;
    
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

    for (const contact of potentialContacts) {
      if (!contact.contactName) continue;
      
      // [THE FIX] Using a more effective and less restrictive search query.
      const searchQuery = `"${contact.contactName}" "${firmName}" LinkedIn Profile`;
      const searchResult = await searchForContact(searchQuery, TAVILY_KEY);
      
      let finalDetails = { email: "", contactNumber: "" };
      let finalUrl = "";

      if (searchResult && searchResult.raw_content) {
        finalUrl = searchResult.url;
        finalDetails = await extractDetailsFromText(contact.contactName, searchResult.raw_content, GEMINI_KEY);
      }
      
      enrichedContacts.push({
        contactName: contact.contactName,
        designation: contact.designation,
        email: finalDetails.email || "",
        linkedIn: finalUrl,
        contactNumber: finalDetails.contactNumber || ""
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
