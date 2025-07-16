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
 * The "Investigator": Scrapes the content of a URL using Firecrawl.
 */
async function getPageContent(urlToScrape, apiKey) {
  try {
    const response = await fetch('https://api.firecrawl.dev/v0/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // Firecrawl uses a Bearer token
      },
      body: JSON.stringify({
        url: urlToScrape
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    // We return the clean markdown content, which is perfect for Gemini
    return data.data.markdown;
  } catch (e) {
    console.error(`Firecrawl failed for URL ${urlToScrape}:`, e);
    return null;
  }
}

/**
 * The "Scout": Uses Gemini to find POTENTIAL leads.
 */
async function getPotentialContacts(firmName, website, geminiKey) {
    const PROMPT_NAMES = `Your task is to identify the names and titles of up to two key decision-makers (e.g., CEO, Founder, Partner) for the company "${firmName}" (${website}). Return ONLY a raw JSON array of objects with "contactName", "designation", and a "linkedInUrl" which is your best guess for their LinkedIn profile.`;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + geminiKey;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_NAMES }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } })
    });
    if (!res.ok) throw new Error(`Gemini name search failed: ${res.statusText}`);
    const gJson = await res.json();
    return JSON.parse(gJson.candidates[0].content.parts[0].text);
}


export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY, FIRECRAWL_API_KEY } = env; // Assumes FIRECRAWL_API_KEY
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!FIRECRAWL_API_KEY) throw new Error("Firecrawl API key not configured.");
    await ensureContactsSourceColumn(DB);

    // 1. SCOUT: Get a list of potential contacts and their likely LinkedIn URLs
    const potentialContacts = await getPotentialContacts(firmName, website, GEMINI_KEY);
    
    let enrichedContacts = [];

    for (const contact of potentialContacts) {
      if (!contact.contactName || !contact.linkedInUrl) continue;

      // 2. INVESTIGATE: Scrape the content of the potential URL to verify it's real
      const pageText = await getPageContent(contact.linkedInUrl, FIRECRAWL_API_KEY);
      
      // If scraping fails or the page is empty, it was a fake link. Skip it.
      if (!pageText) continue;

      // 3. ANALYZE: We now have a VERIFIED link and REAL page text.
      // Ask Gemini to extract the email from the real text.
      const PROMPT_EXTRACT = `From the following text from a verified LinkedIn page, extract the user's email address if present. Respond with a single raw JSON object: {"email": "..."}. If no email is found, use an empty string. Text: """${pageText}"""`;
      const extractionResult = await callGemini(PROMPT_EXTRACT, GEMINI_KEY, 0.0);

      enrichedContacts.push({
        contactName: contact.contactName,
        designation: contact.designation,
        email: extractionResult.email || "",
        linkedIn: contact.linkedInUrl, // We use the URL we successfully scraped
        contactNumber: "" // Phone number is too difficult to find reliably
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

// Re-added the generic callGemini function for the extraction step
async function callGemini(prompt, geminiKey, temperature = 0.0) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + geminiKey;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: temperature }
        })
    });
    if (!response.ok) throw new Error(`Gemini extraction failed: ${response.statusText}`);
    const gJson = await response.json();
    return JSON.parse(gJson.candidates[0].content.parts[0].text);
}
