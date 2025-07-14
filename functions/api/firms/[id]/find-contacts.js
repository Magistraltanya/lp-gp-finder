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

    // [FINAL, SIMPLIFIED PROMPT] Commands the AI to use its search tool with direct, simple instructions.
    const PROMPT = `
You are a data researcher with access to Google Search. Your task is to find up to two key decision-makers (CEO, Partner, Founder, etc.) for the company "${firmName}" found at "${website}".

**Instructions:**
1.  You **MUST** use your Google Search tool to find and verify all information.
2.  The most important piece of information is a **real, working LinkedIn URL** for each contact. If you cannot find a verified LinkedIn URL for a person, do not include them.
3.  Do not invent or guess information. If you cannot find a person's email or phone number from your search, you **MUST** use an empty string "".
4.  Your final output **MUST ONLY** be a raw JSON array containing the contacts you found and verified. Do not include any other text or markdown.

**JSON Output Structure:**
[
  {
    "contactName": "First and Last Name",
    "designation": "Official Title",
    "email": "",
    "linkedIn": "https://www.linkedin.com/in/verified-profile-url",
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
        tools: [{
          "Google Search_retrieval": {}
        }],
        generationConfig: { temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) {
      const errorBody = await geminiRes.text();
      console.error("Gemini API Error Response:", errorBody);
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    
    // Robustly find the part of the response that contains the final text answer.
    const textPart = gJson.candidates[0].content.parts.find(part => 'text' in part);
    let txt = textPart ? textPart.text : '[]';

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
