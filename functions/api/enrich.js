/**
 * POST /api/enrich
 * Fetches and saves strategic details about a firm.
 */
export async function onRequestPost({ request, env }) {
  try {
    const { DB, GEMINI_KEY } = env;
    const { firmId, firmName, website } = await request.json();

    if (!firmId || !firmName) {
      return new Response(JSON.stringify({ error: 'Firm ID and Name are required' }), { status: 400 });
    }

    const PROMPT = `
      You are a world-class financial data analyst at a top-tier investment bank. Your work is meticulous, accurate, and sourced.
      Your task is to create a due diligence summary for the investment firm "${firmName}" (website: ${website}) and return a single, raw JSON object.

      Your research process MUST follow these steps:
      1. Perform targeted Google searches using queries like: "${firmName} assets under management", "${firmName} investment philosophy", "${firmName} recent investments TechCrunch".
      2. Prioritize information from the firm's official website, then major financial news outlets (Bloomberg, Reuters, PitchBook), then other reputable publications.
      3. Synthesize the findings into the JSON structure below. If a specific piece of data cannot be reliably found after a thorough search, you MUST use the string "Not Publicly Disclosed".

      Return a single JSON object with this exact structure:
      {
        "investmentPhilosophy": "...",
        "assetsUnderManagement": "...",
        "typicalCheckSize": "...",
        "recentNews": [
          { "date": "YYYY-MM-DD", "headline": "...", "source": "...", "link": "..." }
        ]
      }
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
    const jsonString = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const data = JSON.parse(jsonString);

    // Save the enriched data to the database
    await DB.prepare(
      `UPDATE firms SET 
        philosophy = ?1, 
        aum = ?2, 
        check_size = ?3, 
        news_json = ?4
       WHERE id = ?5`
    ).bind(
      data.investmentPhilosophy,
      data.assetsUnderManagement,
      data.typicalCheckSize,
      JSON.stringify(data.recentNews || []),
      firmId
    ).run();

    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}
