// worker/enrich.js  –  Cloudflare module worker
export default {
  /**
   * Single route: POST /enrich
   */
  async fetch(request, env, ctx) {
    try {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // ---------------- Environment bindings ----------------
      // Bind these four in your dashboard or wrangler.toml:
      //  DB              = D1 Database binding
      //  GEMINI_KEY      = Gemini API key
      //  GOOGLE_CSE_ID   = Programmable Search Engine CX
      //  GOOGLE_API_KEY  = Google API key
      const { DB, GEMINI_KEY, GOOGLE_CSE_ID, GOOGLE_API_KEY } = env;

      // --------------- Parse body ----------------
      const {
        firmId,
        firmName,
        firmWebsite,
        contactIndex,
        contact
      } = await request.json();

      if (!firmId || !contact || !contact.contactName) {
        return new Response(
          JSON.stringify({ error: 'Missing required data.' }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }

      const firmDomain = new URL(
        firmWebsite.startsWith('http') ? firmWebsite : `https://${firmWebsite}`
      ).hostname.replace('www.', '');

      /* =====================================================
       * 1. GOOGLE PROGRAMMABLE SEARCH → snippets
       * ===================================================== */
      let snippets = [];
      try {
        const q = `"${contact.contactName}" "${firmName}" site:linkedin.com OR ${firmDomain}`;
        const googleURL =
          `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}` +
          `&cx=${GOOGLE_CSE_ID}&num=5&q=${encodeURIComponent(q)}`;

        const googleRes = await fetch(googleURL);
        if (googleRes.ok) {
          const googleJson = await googleRes.json();
          snippets =
            (googleJson.items || []).map((i) => `${i.title} – ${i.link}`) || [];
        }
      } catch (e) {
        // If Google call fails (e.g. bad key), keep snippets empty – Gemini will just be conservative
        console.warn('Google CSE error:', e);
      }

      /* =====================================================
       * 2. GEMINI REQUEST
       * ===================================================== */
      const PROMPT_ENRICH = `
You are an expert contact-data researcher.

EVIDENCE
${snippets.join('\n')}

TASK
Return JSON: {"email":"","linkedIn":"","contactNumber":""}

RULES
• LinkedIn must be https://www.linkedin.com/in/…, match "${contact.contactName}" and show "${firmName}" as current employer. Else "".
• Email must end "@${firmDomain}" and appear in EVIDENCE. Else "".
• Phone only if clearly tied to person. Else "".
• Output exactly one minified JSON object.
`.trim();

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
              maxOutputTokens: 256
            }
          })
        }
      );

      if (!geminiRes.ok) {
        throw new Error(`Gemini error: ${geminiRes.statusText}`);
      }
      const gRaw = await geminiRes.json();
      const enriched = JSON.parse(
        gRaw.candidates[0].content.parts[0].text || '{}'
      );

      /* =====================================================
       * 3. POST-VALIDATION & DEDUP
       * ===================================================== */
      const slugOK = (url, fullName) => {
        try {
          const u = new URL(url);
          if (u.hostname !== 'www.linkedin.com' || !u.pathname.startsWith('/in/')) return false;
          const slug = u.pathname.slice(4).toLowerCase();
          return fullName.toLowerCase().split(/\s+/).some((t) => t.length > 2 && slug.includes(t));
        } catch { return false; }
      };

      // fetch existing contacts
      const firmRow = await DB.prepare('SELECT contacts_json FROM firms WHERE id = ?')
                              .bind(firmId).first();
      const contacts = JSON.parse(firmRow?.contacts_json || '[]');

      // duplicate guards
      const emailSet = new Set(contacts.map((c) => (c.email || '').toLowerCase()));
      const liSet = new Set(contacts.map((c) => (c.linkedIn || '').toLowerCase()));

      if (!enriched.email || emailSet.has(enriched.email.toLowerCase()))
        enriched.email = '';
      if (
        !enriched.linkedIn ||
        !slugOK(enriched.linkedIn, contact.contactName) ||
        liSet.has(enriched.linkedIn.toLowerCase())
      )
        enriched.linkedIn = '';

      /* =====================================================
       * 4. SAVE BACK
       * ===================================================== */
      if (contacts[contactIndex]) {
        contacts[contactIndex].email = enriched.email || '';
        contacts[contactIndex].linkedIn = enriched.linkedIn || '';
        contacts[contactIndex].contactNumber = enriched.contactNumber || '';
      }

      await DB.prepare('UPDATE firms SET contacts_json = ?1 WHERE id = ?2')
               .bind(JSON.stringify(contacts), firmId)
               .run();

      return new Response(JSON.stringify({ contacts }), {
        headers: { 'content-type': 'application/json' }
      });
    } catch (err) {
      console.error('Worker Error:', err);
      return new Response(
        JSON.stringify({ error: err.message || String(err) }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  }
};
