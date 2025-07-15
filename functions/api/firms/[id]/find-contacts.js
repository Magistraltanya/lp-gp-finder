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

    // [FINAL PROMPT v2] The most rigorous possible prompt without using the broken 'tools' feature.
    const PROMPT = `
You are a meticulous data researcher. Your task is to find up to two key decision-makers for the company "${firmName}" (${website}). Your primary objective is to provide VERIFIABLE and ACCURATE data by reasoning from your internal knowledge and providing proof.

**CRITICAL INSTRUCTIONS:**
1.  **Reasoning First:** Before providing an answer, think step-by-step. First, recall information about the company's leadership. Second, recall the standard URL patterns for LinkedIn profiles. Third, construct the most probable, real URL.
2.  **No Invention:** You MUST NOT invent data. A fake or broken LinkedIn URL is a complete failure of the task. If you are not highly confident that a URL is correct based on your training data, you MUST return an empty string "".
3.  **Proof of Work:** For each contact you provide, you must include a "reasoning" key that explains *why* you believe the information is correct (e.g., "This person is widely cited as the CEO in public sources, and this is the common URL format for LinkedIn profiles.").
4.  **Final Output:** Your output MUST be ONLY the raw JSON array.

**JSON OUTPUT FORMAT:**
[
  {
    "contactName": "Full Name of the Person",
    "designation": "Their Official Title",
    "linkedIn": "The most probable, valid URL to their personal LinkedIn profile.",
    "email": "",
    "contactNumber": "",
    "reasoning": "A brief explanation of why this information is believed to be accurate."
  }
]
`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.0 }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const newContactsFromAI = JSON.parse(txt);

    if (!Array.isArray(newContactsFromAI)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    const formattedContacts = newContactsFromAI.map(c => ({
      contactName: c.contactName || "",
      designation: c.designation || "",
      email: c.email || "",
      linkedIn: c.linkedIn || "",
      contactNumber: c.contactNumber || ""
    }));
    
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = formattedContacts.filter(c => c.contactName && c.contactName !== "...");

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
