// This function now only finds potential contact names and titles.
export async function onRequestPost({ request, env, params }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { id } = params;
    const { firmName, website } = await request.json();

    if (!id || !firmName) {
      return new Response(JSON.stringify({ error: 'Firm ID and Name are required' }), { status: 400 });
    }

    const PROMPT_NAMES = `You are a data researcher. Your task is to identify the names and titles of up to three key decision-makers (e.g., CEO, Founder, Partner) for the company "${firmName}" (${website}). Return ONLY a raw JSON array of objects with "contactName" and "designation" keys.`;
    
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_NAMES }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
    });

    if (!geminiRes.ok) { throw new Error(`Gemini API Error: ${geminiRes.statusText}`); }

    const gJson = await geminiRes.json();
    const potentialContacts = JSON.parse(gJson.candidates[0].content.parts[0].text);

    if (!Array.isArray(potentialContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    // Format contacts with empty details to be enriched later
    const newContacts = potentialContacts.map(c => ({
      contactName: c.contactName || "",
      designation: c.designation || "",
      email: "",
      linkedIn: "",
      contactNumber: ""
    })).filter(c => c.contactName);

    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    const mergedContacts = [...existingContacts, ...newContacts];

    await DB.prepare(`UPDATE firms SET contacts_json = ?1, contacts_source = 'Gemini' WHERE id = ?2`)
      .bind(JSON.stringify(mergedContacts), id).run();

    return new Response(JSON.stringify({ contacts: mergedContacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Find Contacts (Initial) Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
