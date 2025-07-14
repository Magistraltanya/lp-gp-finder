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

export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!id || !firmName) {
      return new Response(JSON.stringify({ error: 'Firm ID and Name are required' }), { status: 400 });
    }

    await ensureContactsSourceColumn(DB);

    // [FINAL VERSION] This prompt commands the AI to use its Google Search tool.
    const PROMPT = `
You are a data researcher with direct access to the Google Search tool. Your task is to find and verify contact information for key people at "${firmName}".

**Rules:**
1.  You **MUST** use your Google Search tool to find the official company website and the real LinkedIn profiles of its key decision-makers (CEO, Partners, MDs, etc.).
2.  The "linkedIn" URL in your JSON output **MUST** be a real, working URL that you discovered through search. Do not, under any circumstances, invent a URL.
3.  If you cannot find a specific piece of information (like an email or phone number) from your search results, you **MUST** use an empty string "".
4.  Return up to two of the most senior people you can find and verify.

**Task:**
Use your Google Search tool to find the required information and fill in the JSON template below.

[
  {
    "contactName": "...",
    "designation": "...",
    "email": "",
    "linkedIn": "...",
    "contactNumber": ""
  }
]
`;

    // Using the Pro model is required for reliable tool use.
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        // [NEW] This grants the AI access to Google Search. This is the key change.
        tools: [{
          "Google Search_retrieval": {}
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    
    // The response structure for tool-use can be different. We need to find the final JSON response.
    const modelResponsePart = gJson.candidates[0].content.parts.find(part => part.text);
    let txt = modelResponsePart ? modelResponsePart.text : '[]';

    const jsonString = txt.substring(txt.indexOf('['), txt.lastIndexOf(']') + 1);
    const newContacts = JSON.parse(jsonString);

    if (!Array.isArray(newContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = newContacts.filter(c => c.contactName && c.contactName !== "..." && c.linkedIn && c.linkedIn !== "...");

    const mergedContacts = [...existingContacts, ...verifiedNewContacts];

    await DB.prepare(
      `UPDATE firms SET contacts_json = ?1, contacts_source = 'Gemini' WHERE id = ?2`
    ).bind(JSON.stringify(mergedContacts), id).run();

    return new Response(JSON.stringify({ contacts: mergedContacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Find Contacts Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
