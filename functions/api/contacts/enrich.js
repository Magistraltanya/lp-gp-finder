/**
 * Cloudflare Worker – Contact Enrichment via Gemini
 * -------------------------------------------------
 * Logic is unchanged except for:
 *   • A tighter prompt (PROMPT_ENRICH)
 *   • Deterministic generationConfig
 * Everything else (DB flow, error handling, etc.) is intact.
 */

export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { firmId, firmName, firmWebsite, contactIndex, contact } = await request.json();

    // Basic validation
    if (!firmId || !contact || !contact.contactName) {
      return new Response(
        JSON.stringify({ error: 'Missing required data to enrich contact.' }),
        { status: 400 }
      );
    }

    // Extract clean domain (acme.com → acme.com)
    const firmDomain = new URL(
      firmWebsite.startsWith('http') ? firmWebsite : `https://${firmWebsite}`
    ).hostname.replace('www.', '');

    /* ------------------------------------------------------------------ *
     *  Refined Gemini prompt – single-line JSON, strict matching rules
     * ------------------------------------------------------------------ */
    const PROMPT_ENRICH = `
You are an expert contact-data researcher.

TASK
Return one minified JSON object with exactly these keys:
{"email":"","linkedIn":"","contactNumber":""}

RULES
1. Use internet and use secondaryPublic sources only (LinkedIn profile, company site, press, registry). Do not hallucinate information
2. "linkedIn":
   • Search "${contact.contactName}" "${firmName}" LinkedIn.
   • Select the profile whose headline OR Experience shows "${contact.designation}" (or close) and lists "${firmName}" (or equivalent) as CURRENT employer.
   • URL must start "https://www.linkedin.com/in/" – no posts or /company/ pages. But dont provide hallucinate Linkedin Ids.
3. "email":
   • Search for the person's email Id on internet. Detect the real pattern for domain "${firmDomain}" (e.g. first.last@, etc).
   • If a verified personal address exists, output it.
   • If NO verified hit and ≥2 examples confirm a pattern, construct the email; otherwise leave "".
4. "contactNumber":
   • Provide a direct dial or mobile clearly attributed to the person (LinkedIn contact info, company bio, filings). Otherwise leave "".
5. If any item cannot be confirmed confidently, keep it "".
6. Think step-by-step privately. OUTPUT ONLY the final JSON object on one line – no commentary, no markdown.
`.trim();

    // Call Gemini
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' +
      GEMINI_KEY;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,       // deterministic
          topP: 0.1,
          maxOutputTokens: 256
        }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini Enrichment API Error: ${geminiRes.statusText}`);
    }

    const gJson = await geminiRes.json();
    const enrichedData = JSON.parse(gJson.candidates[0].content.parts[0].text);

    /* ------------------------- DB update logic ------------------------- */
    const firm = await DB.prepare('SELECT contacts_json FROM firms WHERE id = ?')
      .bind(firmId)
      .first();

    let contacts = JSON.parse(firm.contacts_json || '[]');

    if (contacts[contactIndex]) {
      contacts[contactIndex].email = enrichedData.email || '';
      contacts[contactIndex].linkedIn = enrichedData.linkedIn || '';
      contacts[contactIndex].contactNumber = enrichedData.contactNumber || '';
    }

    await DB.prepare('UPDATE firms SET contacts_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(contacts), firmId)
      .run();

    return new Response(JSON.stringify({ contacts }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    console.error('Enrich Contact Error:', e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 500
    });
  }
}
