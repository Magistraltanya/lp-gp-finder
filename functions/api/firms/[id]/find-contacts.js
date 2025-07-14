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

    // [FINAL PROMPT] Incorporates source hierarchy and URL reality checks.
    const PROMPT = `
You are a meticulous financial data researcher. Your task is to find two key decision-makers for the company "${firmName}" (${website}).

**Golden Rule:** A valid, working LinkedIn URL is mandatory. It is better to return ONE fully verified contact with a working URL than two contacts with fake data.

**Mandatory Research Process:**
1.  **Source Hierarchy:** You must prioritize sources in this order: Official Company Website ("Team" or "Leadership" page) > Official LinkedIn Page > Reputable secondary sources (e.g., Bloomberg, PitchBook, Crunchbase).
2.  **URL Reality Check:** Before outputting a LinkedIn URL, you must act as if you are verifying it is a real, active profile for the correct person. Do not guess or generate plausible-looking but fake URLs.
3.  **No Placeholders:** You are strictly forbidden from using "Unknown" or "N/A". If data cannot be verified from a reputable source, use an empty string "".

**Output Format:**
Return ONLY a raw JSON array of up to two contact objects.

**JSON Template to Complete:**
[
  {
    "contactName": "...",
    "designation": "...",
    "email": "...",
    "linkedIn": "...",
    "contactNumber": "..."
  }
]
`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const jsonString = txt.substring(txt.indexOf('['), txt.lastIndexOf(']') + 1);
    const newContacts = JSON.parse(jsonString);

    if (!Array.isArray(newContacts)) {
      throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = newContacts.filter(c => c.contactName && c.contactName !== "..." && c.linkedIn);

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
