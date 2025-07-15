// functions/api/contacts/enrich.js
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY } = env;
    const { contactName, designation, firmName } = await request.json();

    if (!contactName || !firmName) {
      return new Response(JSON.stringify({ error: 'Contact Name and Firm Name are required' }), { status: 400 });
    }

    const PROMPT_ENRICH = `
You are a high-accuracy data enrichment specialist. Your task is to find the specific contact details for a known individual at a known company.

**Individual:** ${contactName}
**Title:** ${designation}
**Company:** ${firmName}

**Instructions:**
1.  Perform a targeted search to find the official LinkedIn profile, a verifiable email address, and a contact phone number for this specific person.
2.  Prioritize accuracy. If a piece of data cannot be found, use an empty string "". Do not guess.
3.  Your output MUST be a single, raw JSON object.

**JSON Output Structure:**
{
  "email": "...",
  "linkedIn": "...",
  "contactNumber": "..."
}
`;
    
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini Enrichment API Error: ${geminiRes.statusText}`);
    }

    const gJson = await geminiRes.json();
    const enrichedData = JSON.parse(gJson.candidates[0].content.parts[0].text);

    return new Response(JSON.stringify(enrichedData), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Enrich Contact Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
