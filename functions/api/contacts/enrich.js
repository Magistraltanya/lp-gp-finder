/**
 * Cloudflare Worker – Contact Enrichment (search-assisted)
 * - Uses Google Programmable Search JSON API to fetch snippets
 * - Feeds snippets to Gemini for reasoning
 * - Post-validates to avoid duplicate or bogus outputs
 */

export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY, GOOGLE_CSE_ID, GOOGLE_API_KEY } = env;
    const { firmId, firmName, firmWebsite, contactIndex, contact } = await request.json();

    if (!firmId || !contact?.contactName) {
      return new Response(JSON.stringify({ error: 'Missing required data.' }), { status: 400 });
    }

    const firmDomain = new URL(
      firmWebsite.startsWith('http') ? firmWebsite : `https://${firmWebsite}`
    ).hostname.replace('www.', '');

    /* ------------------------------------------------------------ *
     * 1. Google CSE – get top snippets that mention the person
     * ------------------------------------------------------------ */
    const q = encodeURIComponent(
      `"${contact.contactName}" "${firmName}" site:linkedin.com OR ${firmDomain}`
    );
    const googleURL = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}` +
                      `&cx=${GOOGLE_CSE_ID}&num=5&q=${q}`;
    const googleRes = await fetch(googleURL);
    const googleJson = googleRes.ok ? await googleRes.json() : { items: [] };
    const snippets = (googleJson.items || []).map(i => `${i.title} – ${i.link}`);

    /* ------------------------------------------------------------ *
     * 2. Gemini prompt – includes evidence snippets
     * ------------------------------------------------------------ */
    const PROMPT_ENRICH = `
You are an expert contact-data researcher.

EVIDENCE
${snippets.join('\n')}

TASK
Return a minified JSON: {"email":"","linkedIn":"","contactNumber":""}

RULES
• LinkedIn: choose only if evidence shows the profile belongs to "${contact.contactName}" and lists "${firmName}" as current employer. URL must start https://www.linkedin.com/in/.
• Email: must end "@${firmDomain}". Supply it only if explicitly present in EVIDENCE; never guess.
• contactNumber: only if clearly tied to the person in EVIDENCE.
• If uncertain, leave field "".
• No commentary – output exactly one JSON object on one line.
`.trim();

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 256 }
        })
      }
    );
    if (!geminiRes.ok) throw new Error(`Gemini error ${geminiRes.statusText}`);
    const enriched = JSON.parse((await geminiRes.json()).candidates[0].content.parts[0].text);

    /* ------------------------------------------------------------ *
     * 3. Post-validation
     * ------------------------------------------------------------ */
    const slugOK = (url, fullName) => {
      try {
        const u = new URL(url.trim());
        if (u.hostname !== 'www.linkedin.com' || !u.pathname.startsWith('/in/')) return false;
        const slug = u.pathname.slice(4).toLowerCase();
        return fullName
          .toLowerCase()
          .split(/\s+/)
          .some(t => t.length > 2 && slug.includes(t));
      } catch { return false; }
    };

    // fetch current contacts to detect duplicates
    const firmRow = await DB.prepare('SELECT contacts_json FROM firms WHERE id = ?')
                            .bind(firmId).first();
    const contacts = JSON.parse(firmRow?.contacts_json || '[]');

    const emailsInUse = new Set(contacts.map(c => (c?.email || '').toLowerCase()));
    const linkedInInUse = new Set(contacts.map(c => (c?.linkedIn || '').toLowerCase()));

    if (!enriched.email || emailsInUse.has(enriched.email.toLowerCase()))
      enriched.email = '';

    if (!enriched.linkedIn || !slugOK(enriched.linkedIn, contact.contactName) ||
        linkedInInUse.has(enriched.linkedIn.toLowerCase()))
      enriched.linkedIn = '';

    /* ------------------------------------------------------------ *
     * 4. Save back to DB
     * ------------------------------------------------------------ */
    if (contacts[contactIndex]) {
      contacts[contactIndex].email         = enriched.email         || '';
      contacts[contactIndex].linkedIn      = enriched.linkedIn      || '';
      contacts[contactIndex].contactNumber = enriched.contactNumber || '';
    }

    await DB.prepare('UPDATE firms SET contacts_json = ?1 WHERE id = ?2')
             .bind(JSON.stringify(contacts), firmId).run();

    return new Response(JSON.stringify({ contacts }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    console.error('Enrich Contact Error:', err);
    return new Resp
