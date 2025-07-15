export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { firmId, firmName, firmWebsite, contactIndex, contact } = await request.json();

    if (!firmId || !contact || !contact.contactName) {
      return new Response(JSON.stringify({ error: 'Missing required data to enrich contact.' }), { status: 400 });
    }

    // [ULTIMATE PROMPT] Incorporates your full, detailed methodology.
    const PROMPT_ENRICH = `
You are a world-class Lead Generation and Data Verification Specialist. Your mission is to conduct a rigorous investigation to find the accurate and verifiable contact details for a high-value lead.

**Target Profile:**
* **Name:** "${contact.contactName}"
* **Known Title:** "${contact.designation}"
* **Company:** "${firmName}"
* **Company Website:** "${firmWebsite}"

---
### **Mandatory 4-Step Verification Process**

**Step 1: Foundational Search & Role Confirmation**
* Perform a targeted Google search using queries like \`"${contact.contactName}" "${firmName}"\`.
* Cross-reference results from the company's official website (e.g., "Team" or "Leadership" page) and reputable news articles to confirm this person's role at this company.

**Step 2: LinkedIn URL Validation (Highest Priority)**
* Your primary goal is to find the **one, true, canonical LinkedIn profile URL**. It must be a personal profile (containing "/in/").
* **VALIDATE THE URL:** A real profile will have a profile picture, a headline matching the designation, and work experience listing the target company. If your search returns links to posts or articles (\`/posts/\`, \`/feed/\`), you must find the author's profile link from that page. Do not return the post link itself.

**Step 3: Accurate Email Identification**
* First, search for the direct email address using queries like \`"${contact.contactName}" email site:${firmWebsite}\`.
* If not found, search for the company's email format by looking for other employees' emails.
* If you can confidently determine a pattern (e.g., \`first.last@company.com\`), construct the email for your target.

**Step 4: Phone Number Identification**
* Look for a direct dial number in the "Contact Info" section of the verified LinkedIn profile or on official corporate biographies. If only a general office number is available, you may use that.

---
### **CRITICAL RULES**
* **ZERO TOLERANCE FOR FAKES:** A fake or broken LinkedIn URL is a complete failure.
* **EMPTY IS BETTER THAN WRONG:** If any piece of information cannot be verified through this process, you **MUST** use an empty string \`""\`.
* **OUTPUT FORMAT:** Your final response must be ONLY a single, raw JSON object.

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
