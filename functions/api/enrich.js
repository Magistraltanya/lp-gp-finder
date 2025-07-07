/**
 * POST /api/enrich
 * Body: { firmName, website }
 * This function takes a firm's name and fetches detailed intelligence using Gemini.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { GEMINI_KEY } = env;
    const { firmName, website } = await request.json();

    if (!firmName) {
      return new Response(JSON.stringify({ error: 'Firm name is required' }), { status: 400 });
    }

    const PROMPT = `
      You are a financial analyst. For the investment firm "${firmName}" with the website "${website}", research and return a single JSON object with the following structure.
      Do not use markdown formatting. The response must be only the raw JSON object.

      {
        "recentNews": [
          { "date": "YYYY-MM-DD", "headline": "...", "source": "..." }
        ],
        "keyPersonnel": [
          { "name": "...", "title": "..." }
        ],
        "assetsUnderManagement": "...",
        "typicalCheckSize": "..."
      }

      Instructions:
      1.  **recentNews**: Find up to three recent (last 12 months) news articles, press releases, or funding announcements. Provide a date, a concise headline, and the source name.
      2.  **keyPersonnel**: Identify up to three key partners or decision-makers and their titles.
      3.  **assetsUnderManagement**: State the firm's AUM (e.g., "$500M", "€2B"). If not found, state "Not publicly disclosed".
      4.  **typicalCheckSize**: State the firm's typical investment size (e.g., "$1M - $5M"). If not found, state "Not disclosed".
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

    if (!geminiRes.ok) {
      throw new Error(`Gemini API Error: ${geminiRes.status}`);
    }

    const gJson = await geminiRes.json();
    let txt = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    // Basic cleanup to find the JSON object
    const startIndex = txt.indexOf('{');
    const endIndex = txt.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1) {
      throw new Error("Gemini response did not contain a valid JSON object.");
    }
    const jsonString = txt.substring(startIndex, endIndex + 1);
    const data = JSON.parse(jsonString);

    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
