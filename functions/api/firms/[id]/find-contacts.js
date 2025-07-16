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

    // --- The Final Prompt, designed for Google Search Grounding ---
    const PROMPT = `
You are a data researcher with live access to Google Search.
Your task is to find up to two key decision-makers (e.g., CEO, Founder, Partner) for the company "${firmName}" (${website}).

**Instructions:**
1.  Use your Google Search tool to find and verify all information.
2.  Your primary goal is to find real, working, and accurate LinkedIn profile URLs for each contact.
3.  If you find a public email or contact number from a reliable source, include it. Otherwise, use an empty string "".
4.  Your final output must be a raw JSON array. Do not invent data.

**JSON Output Structure:**
[
  {
    "contactName": "Full Name",
    "designation": "Official Title",
    "email": "",
    "linkedIn": "A real and verified LinkedIn URL",
    "contactNumber": ""
  }
]
`;

    // --- The Correct Vertex AI Endpoint with your Project ID ---
    const PROJECT_ID = "gen-lang-client-0134744668";
    const REGION = "us-central1";
    
    // The final, correct URL structure with the API key in the query string.
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_KEY}`;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
    
    const textPart = gJson.candidates[0].content.parts.find(part => 'text' in part);
    let txt = textPart ? textPart.text.trim() : '[]';
    
    if (txt.startsWith("```json")) {
        txt = txt.substring(7, txt.length - 3).trim();
    }
    
    const newContacts = JSON.parse(txt);

    if (!Array.isArray(newContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = newContacts.filter(c => c.contactName && c.contactName !== "...");

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
