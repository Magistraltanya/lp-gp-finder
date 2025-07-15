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

    // [FINAL PROMPT - "Show Your Work" Method]
    const PROMPT = `
You are a meticulous data researcher. Your task is to find up to two key decision-makers for the company "${firmName}" (${website}). Your primary objective is to provide VERIFIABLE and ACCURATE data.

**CRITICAL INSTRUCTIONS:**
1.  Your output MUST be a single raw JSON array. Do not include any other text.
2.  You MUST NOT invent any data, especially LinkedIn URLs. A fake URL is a complete failure.
3.  For each contact you return, you MUST include a "sourceURL" key containing the exact webpage URL (e.g., the company's team page, a news article, a Bloomberg profile) where you VERIFIED the person's name, title, and LinkedIn URL.

**JSON OUTPUT FORMAT:**
[
  {
    "contactName": "Full Name of the Person",
    "designation": "Their Official Title",
    "linkedIn": "The DIRECT and VERIFIED URL to their personal LinkedIn profile.",
    "sourceURL": "The webpage URL that proves the contact's details are correct."
  }
]
`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        // Re-introducing responseMimeType as we are no longer using tools
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) {
      const errorBody = await geminiRes.text();
      console.error("Gemini API Error Response:", errorBody);
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const newContactsFromAI = JSON.parse(txt);

    if (!Array.isArray(newContactsFromAI)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    // Map the AI response to the structure our database expects, ignoring the sourceURL
    const formattedContacts = newContactsFromAI.map(c => ({
      contactName: c.contactName,
      designation: c.designation,
      email: "", // We are not asking for email to improve reliability
      linkedIn: c.linkedIn,
      contactNumber: "" // We are not asking for phone to improve reliability
    }));

    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = formattedContacts.filter(c => c.contactName && c.contactName !== "..." && c.linkedIn && c.linkedIn !== "...");

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
