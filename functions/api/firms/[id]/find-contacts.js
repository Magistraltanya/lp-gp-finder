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

    // [FINAL, HIGH-ACCURACY PROMPT]
    const PROMPT = `
<prompt>
  <role>
    You are a meticulous, high-accuracy data verification and enrichment specialist. Your sole purpose is to find real, verifiable contact information for key personnel at a given company.
  </role>

  <rules>
    <rule>Your output MUST be ONLY the raw JSON array. Do not include any other text, explanations, or markdown.</rule>
    <rule>You MUST follow the step-by-step research process internally.</rule>
    <rule>DO NOT invent or guess any information, especially LinkedIn URLs or email addresses. An empty string "" is infinitely better than a fake or incorrect data point.</rule>
    <rule>A valid, working, and correct LinkedIn URL for the contact is the highest priority. If you cannot find a valid URL for a person, do not include them in the results.</rule>
  </rules>

  <process>
    <step id="1">Receive the target company: <company name="${firmName}" website="${website}" />.</step>
    <step id="2">Simulate a targeted search on Google and LinkedIn for the company's key decision-makers (CEO, Founder, Partner, Managing Director).</step>
    <step id="3">For each potential lead, verify their current role and the authenticity of their LinkedIn profile URL. A real URL is mandatory.</step>
    <step id="4">Attempt to find a publicly listed email address. If found, include it. If not found, you must use an empty string "".</step>
    <step id="5">Format up to two of the most senior, fully-verified leads you find into the JSON structure provided.</step>
  </process>

  <example_output>
  [
    {
      "contactName": "Satya Nadella",
      "designation": "Chairman & Chief Executive Officer",
      "email": "",
      "linkedIn": "https://www.linkedin.com/in/satyanadella/",
      "contactNumber": ""
    }
  ]
  </example_output>

  <final_task>
  Now, perform this process for the company specified in Step 1. Fill in the template below with the verified data you find.

  [
    {
      "contactName": "...",
      "designation": "...",
      "email": "...",
      "linkedIn": "...",
      "contactNumber": "..."
    },
    {
      "contactName": "...",
      "designation": "...",
      "email": "...",
      "linkedIn": "...",
      "contactNumber": "..."
    }
  ]
  </final_task>
</prompt>
`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=' + GEMINI_KEY;
    
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.statusText} (${geminiRes.status})`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const jsonString = txt.substring(txt.indexOf('['), txt.lastIndexOf(']') + 1);
    const newContacts = JSON.parse(jsonString);

    if (!Array.isArray(newContacts)) {
        throw new Error("Gemini did not return a valid array of contacts.");
    }
    
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(id).first();
    const existingContacts = JSON.parse(firm.contacts_json || '[]');
    
    const verifiedNewContacts = newContacts.filter(c => c.contactName && c.contactName !== "..." && c.linkedIn && c.linkedIn !== "...");

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
