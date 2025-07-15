export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    // The front-end now sends all necessary data
    const { firmId, contactIndex, contact, firmName } = await request.json();

    if (!firmId || contactIndex === undefined || !contact || !contact.contactName) {
      return new Response(JSON.stringify({ error: 'Missing required data to enrich contact.' }), { status: 400 });
    }

    const PROMPT_ENRICH = `
You are an expert Lead Generation Specialist. Your task is to perform a rigorous, multi-step research process to find the accurate contact details for a specific person at a specific company.

**Target:**
* **Person:** "${contact.contactName}"
* **Title:** "${contact.designation}"
* **Company:** "${firmName}"

---
### **Mandatory Research Methodology**

**Step 1: Website & Google Verification**
* First, search Google for the company's official website. Navigate to any "Team", "Leadership", or "About Us" pages to confirm the person's role.
* If a team page is not available, perform targeted Google searches like \`"${contact.contactName}" "${firmName}"\` to verify the role using at least two independent sources (e.g., a LinkedIn profile and a news article).

**Step 2: LinkedIn Verification**
* Find the individual's real, personal LinkedIn profile URL. The URL format must be \`https://www.linkedin.com/in/...\`.
* You must verify that their current listed employer on the profile matches the target company. **A fake or incorrect URL is a complete failure of this task.**

**Step 3: Accurate Email Identification**
* Use advanced Google searches like \`"${contact.contactName}" email\` and \`*@companydomain.com filetype:pdf\` to find publicly listed emails and verify the company's email pattern.
* Construct the most likely email for the target person using a verified pattern. If no pattern can be verified, leave the email as an empty string. Do not use generic \`info@\` emails.

**Step 4: Phone Number Identification**
* Check the verified LinkedIn profile's "Contact Info" section or official company biographies for a direct phone number. If unavailable, leave as an empty string.

---
### **Final Output**

Return a single, raw JSON object with the verified data you have found. If a piece of information cannot be verified through this rigorous process, you **MUST** use an empty string "".

**JSON Structure:**
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
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT_ENRICH }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });

    if (!geminiRes.ok) { throw new Error(`Gemini Enrichment API Error: ${geminiRes.statusText}`); }

    const gJson = await geminiRes.json();
    const enrichedData = JSON.parse(gJson.candidates[0].content.parts[0].text);

    // Get the firm's current contacts
    const firm = await DB.prepare("SELECT contacts_json FROM firms WHERE id = ?").bind(firmId).first();
    let contacts = JSON.parse(firm.contacts_json || '[]');
    
    // Update the specific contact at the given index
    if (contacts[contactIndex]) {
        contacts[contactIndex].email = enrichedData.email || "";
        contacts[contactIndex].linkedIn = enrichedData.linkedIn || "";
        // [THE FIX] Corrected the typo on the line below
        contacts[contactIndex].contactNumber = enrichedData.contactNumber || "";
    }

    // Save the entire updated array back to the database.
    await DB.prepare(`UPDATE firms SET contacts_json = ?1 WHERE id = ?2`).bind(JSON.stringify(contacts), firmId).run();

    return new Response(JSON.stringify({ contacts: contacts }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error("Enrich Contact Error:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
