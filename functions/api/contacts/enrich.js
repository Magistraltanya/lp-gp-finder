export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { firmId, firmName, firmWebsite, contactIndex, contact } = await request.json();

    if (!firmId || !contact || !contact.contactName) {
      return new Response(JSON.stringify({ error: 'Missing required data to enrich contact.' }), { status: 400 });
    }
    
    const firmDomain = new URL(firmWebsite.startsWith('http') ? firmWebsite : `https://${firmWebsite}`).hostname.replace('www.','');

    // [FINAL AUTOMATION ATTEMPT] A completely new, more direct prompt structure.
    const PROMPT_ENRICH = `{
  "email": "Find a verified, non-generic email address for ${contact.contactName}. Use Google search patterns like \\"*@${firmDomain}\\" to find the company's email format and construct the email.",
  "linkedIn": "Find the single, official, and working personal LinkedIn profile URL for ${contact.contactName}, the ${contact.designation} at ${firmName}. Do not provide a link to a post or a company page.",
  "contactNumber": "Find a direct-dial or business phone number from the person's verified public profiles."
}`;
    
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) { throw new Error(`Gemini Enrichment API Error: ${geminiRes.statusText}`); }

    const gJson = await geminiRes.json();
    const enrichedData = JSON.parse(gJson.candidates[0].content.parts[0].text);

    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(firmId).first();
    let contacts = JSON.parse(firm.contacts_json || '[]');
    
    if (contacts[contactIndex]) {
        contacts[contactIndex].email = enrichedData.email || "";
        contacts[contactIndex].linkedIn = enrichedData.linkedIn || "";
        contacts[contactIndex].contactNumber = enrichedData.contactNumber || "";
    }

    await DB.prepare(`UPDATE firms SET contacts_json = ?1 WHERE id = ?2`).bind(JSON.stringify(contacts), firmId).run();

    return new Response(JSON.stringify({ contacts: contacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Enrich Contact Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
