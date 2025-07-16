/**
 * Cloudflare Worker – Contact Enrichment (v2)
 * ------------------------------------------
 * • Stricter Gemini prompt (PROMPT_ENRICH)
 * • validateLinkedIn() post-check
 * All other logic unchanged.
 */

export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { firmId, firmName, firmWebsite, contactIndex, contact } = await request.json();

    if (!firmId || !contact?.contactName) {
      return new Response(JSON.stringify({ error: 'Missing required data to enrich contact.' }), { status: 400 });
    }

    /* ---------- helpers ---------- */
    const firmDomain = new URL(
      firmWebsite.startsWith('http') ? firmWebsite : `https://${firmWebsite}`
    ).hostname.replace('www.', '');

    // Simple slug check – catches most mismatches
    const validateLinkedIn = (url, fullName) => {
      try {
        const u = new URL(url.trim());
        if (u.hostname !== 'www.linkedin.com' || !u.pathname.startsWith('/in/')) return false;
        const slug = u.pathname.slice(4).toLowerCase();          // after "/in/"
        return fullName
          .toLowerCase()
          .split(/\s+/)
          .some(tok => tok.length > 2 && slug.includes(tok));    // token appears in slug
      } catch { return false; }
    };

    /* ---------- tighter prompt ---------- */
    const PROMPT_ENRICH = `
You are an expert open-source contact researcher.

GOAL
Return one minified JSON object ("email","linkedIn","contactNumber") – nothing else.

STRICT RULES
• "linkedIn": Only if you can confirm the profile’s Experience (or About) lists "${firmName}" as CURRENT employer **and** headline shows "${contact.designation}" or close variant. If not 100 % sure, output "".
• The URL must start exactly "https://www.linkedin.com/in/" (no company pages, posts, or trackers).
• "email": Provide a verified personal address at domain "${firmDomain}". If none verified and you cannot confirm the firm’s pattern with ≥2 examples, output "".
• "contactNumber": Direct dial or mobile clearly attributed to the person from a trustworthy source; else "".
• Never guess. Leave any unconfirmed field "".
• Think silently; output only the final object on a single line.
`.trim();

    /* ---------- Gemini call ---------- */
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
            topP: 0.05,
            maxOutputTokens: 256
          }
        })
      }
    );

    if (!geminiRes.ok) throw new Error(`Gemini API error: ${geminiRes.statusText}`);

    const gJson = await geminiRes.json();
    const enriched = JSON.parse(gJson.candidates[0].content.parts[0].text);

    /* ---------- post-validation ---------- */
    if (enriched.linkedIn && !validateLinkedIn(enriched.linkedIn, contact.contactName))
      enriched.linkedIn = '';   // purge doubtful link

    if (enriched.email && !enriched.email.endsWith(`@${firmDomain}`))
      enriched.email = '';      // wrong domain → blank

    /* ---------- DB update ---------- */
    const firm = await DB.prepare('SELECT contacts_json FROM firms WHERE id = ?')
                          .bind(firmId).first();
    const contacts = JSON.parse(firm?.contacts_json || '[]');

    if (contacts[contactIndex]) {
      contacts[contactIndex].email         = enriched.email         || '';
      contacts[contactIndex].linkedIn      = enriched.linkedIn      || '';
      contacts[contactIndex].contactNumber = enriched.contactNumber || '';
    }

    await DB.prepare('UPDATE firms SET contacts_json = ?1 WHERE id = ?2')
             .bind(JSON.stringify(contacts), firmId).run();

    return new Response(JSON.stringify({ contacts }), { headers: { 'content-type': 'application/json' } });

  } catch (err) {
    console.error('Enrich Contact Error:', err);
    return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 500 });
  }
}
