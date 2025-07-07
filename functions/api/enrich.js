/**
 * POST /api/enrich
 * Fetches strategic details about a firm with an improved, more robust prompt.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY } = env;
    const { firmName, website } = await request.json();

    if (!firmName) {
      return new Response(JSON.stringify({ error: 'Firm name is required' }), { status: 400 });
    }

    const PROMPT = `
      You are an expert financial data analyst specializing in private markets. Your task is to meticulously research the investment firm "${firmName}" (website: ${website}) and return a single, raw JSON object. Do not use markdown.

      Your research process MUST follow these steps:
      1.  Prioritize information from the firm's official website, regulatory filings (like SEC EDGAR), and press releases.
      2.  Supplement with data from reputable financial news sources like PitchBook, Preqin, TechCrunch, Axios Pro, etc.
      3.  Synthesize the findings into the JSON structure below. If a specific piece of data cannot be found after a thorough search, use the value "Not Found".

      Return a single JSON object with this exact structure:
      {
        "investmentPhilosophy": "...",
        "assetsUnderManagement": "...",
        "typicalCheckSize": "...",
        "recentNews": [
            { "date": "YYYY-MM-DD", "headline": "...", "source": "...", "link": "..." }
        ]
      }

      Field Instructions:
      - "investmentPhilosophy": Summarize the firm's core investment thesis, focus, or approach in 1-3 sentences. This should be a close paraphrase or direct quote from their "About Us" or "Strategy" page.
      - "assetsUnderManagement": State the firm's most recently reported Assets Under Management (AUM). Example: "$1.2 Billion".
      - "typicalCheckSize": State the firm's typical investment size or range. Example: "$5M - $15M".
      - "recentNews": Provide up to 3 of the most recent, relevant news items (investments, fundraises, exits). Include the date, a concise headline, the name of the source publication, and a direct URL to the article.
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
