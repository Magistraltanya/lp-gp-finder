/**
 * Ensures the 'contacts_source' column exists in the firms table.
 * This is a safe, one-time operation.
 */
async function ensureContactsSourceColumn(DB) {
  try {
    await DB.prepare(`SELECT contacts_source FROM firms LIMIT 1`).first();
  } catch (e) {
    // If the column doesn't exist, add it.
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

    // [NEW] Stricter, zero-tolerance prompt for higher quality results.
    const PROMPT = `
You are a lead generation specialist AI. Your task is to find two key decision-makers (e.g., Founder, CEO, Partner, Managing Director) for the company "${firmName}" with the website "${website}".

**Constraint Checklist (MUST be followed):**
1.  **No Placeholders:** You are strictly forbidden from using placeholder text like "Unknown", "N/A", or "Not Disclosed".
2.  **Empty Strings Only:** If, after a thorough search, a specific piece of information cannot be found, you MUST use an empty string "" as the value.
3.  **Verification is Mandatory:** You must simulate a search of the company's website and LinkedIn to verify the person's current role and details.
4.  **Find Two Leads:** Return a JSON array containing up to two of the most senior and relevant contacts you can find.

**Output Format:**
Return ONLY a raw JSON array. Do not use markdown.

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
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.status}`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const jsonString = txt.substring(txt.indexOf('['), txt.lastIndexOf(']') + 1);
    const newContacts = JSON.parse(jsonString);

    if (!Array.isArray(newContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    // Get existing contacts from the database
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    // Merge existing and new contacts
    const mergedContacts = [...existingContacts, ...newContacts];

    // Update the firm record with the merged contacts and set the source
    await DB.prepare(
      `UPDATE firms SET contacts_json = ?1, contacts_source = 'Gemini' WHERE id = ?2`
    ).bind(JSON.stringify(mergedContacts), id).run();

    return new Response(JSON.stringify({ contacts: mergedContacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Find Contacts Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
