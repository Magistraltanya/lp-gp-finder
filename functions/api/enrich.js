/**
 * POST /api/enrich
 * Fetches strategic details about a firm with a greatly improved, more robust prompt.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY } = env;
    const { firmName, website } = await request.json();

    if (!firmName) {
      return new Response(JSON.stringify({ error: 'Firm name is required' }), { status: 400 });
    }

    const PROMPT = `
      You are a world-class financial analyst at a top-tier investment bank. Your work is meticulous, accurate, and verifiable.
      Your task is to create a due diligence summary for the investment firm "${firmName}" (website: ${website}) and return a single, raw JSON object.

      Your research process MUST follow these steps:
      1.  Perform targeted Google searches using queries like: "${firmName} assets under management", "${firmName} investment philosophy", "${firmName} recent news", "${firmName} notable exits".
      2.  Prioritize information from the firm's official website, then major financial news outlets (Bloomberg, Reuters, PitchBook, TechCrunch), then other reputable sources.
      3.  Synthesize the findings into the JSON structure below. If a specific piece of data cannot be reliably found, the value for that key must be "Not Publicly Disclosed".

      Return a single JSON object with this exact structure, using double quotes for all keys and string values:
      {
        "investmentPhilosophy": "...",
        "assetsUnderManagement": "...",
        "typicalCheckSize": "...",
        "recentNews": [
          { "date": "YYYY-MM-DD", "headline": "...", "source": "...", "link": "..." }
        ]
      }

      Field Instructions:
      - "investmentPhilosophy": Analyze the 'About Us', 'Strategy', or 'Approach' sections of their website. Synthesize their stated philosophy into a concise paragraph.
      - "assetsUnderManagement": Find the most recently reported Assets Under Management. Example: "$1.2 Billion".
      - "typicalCheckSize": Find their stated typical investment size or range. Example: "$5M - $25M".
      - "recentNews": Provide up to the three most recent, relevant news items (investments, fundraises, major hires). Include the date, a concise headline, the source publication name, and a direct verifiable URL to the article. If no verifiable news is found, return an empty array [].
    `;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });

    if (!geminiRes.ok) { throw new Error(`Gemini API Error: ${geminiRes.status}`); }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    const startIndex = txt.indexOf('{');
    const endIndex = txt.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1) { throw new Error("Gemini response did not contain a valid JSON object."); }
    const jsonString = txt.substring(startIndex, endIndex + 1);
    const data = JSON.parse(jsonString);

    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
