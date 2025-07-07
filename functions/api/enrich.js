/**
 * POST /api/enrich
 * Fetches strategic details about a firm.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY } = env;
    const { firmName, website } = await request.json();

    if (!firmName) {
      return new Response(JSON.stringify({ error: 'Firm name is required' }), { status: 400 });
    }

    const PROMPT = `
      You are a sharp financial analyst. For the investment firm "${firmName}" with the website "${website}", research and return a single JSON object with the following structure.
      Do not use markdown formatting. The response must be only the raw JSON object.

      {
        "investmentPhilosophy": "...",
        "assetsUnderManagement": "...",
        "typicalCheckSize": "...",
        "recentNews": [
            { "date": "YYYY-MM-DD", "headline": "...", "source": "..." }
        ],
        "portfolioHighlights": ["...", "..."],
        "notableExits": ["..."]
      }

      Instructions:
      1.  investmentPhilosophy: Concisely summarize the firm's investment thesis in 1-2 sentences.
      2.  assetsUnderManagement: State the firm's AUM. If not found, state "Not publicly disclosed".
      3.  typicalCheckSize: State the firm's typical investment size. If not found, state "Not disclosed".
      4.  recentNews: Find up to 3 recent news articles. Provide a date, a concise headline, and the source.
      5.  portfolioHighlights: List up to 3 notable current portfolio companies.
      6.  notableExits: List up to 2 notable past exits (IPOs or acquisitions). If none, return an empty array [].
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
