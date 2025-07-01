/**
 * POST /api/find-investors
 * Body : { entityType, subType, sector, geo }
 * Return: array of fully-structured firm objects
 */
export async function onRequest({ request, env }) {
  const { GEMINI_KEY, DB } = env;

  if (request.method !== "POST")
    return new Response("Use POST", { status: 405 });

  try {
    /* ---------- parameters ---------- */
    const { entityType, subType, sector, geo } = await request.json();
    if (!entityType || !subType || !sector || !geo)
      return respond({ error: "Missing parameter" }, 400);

    /* ---------- build prompt ---------- */
    const ruleBook = `
You are a professional private-markets researcher.
Follow ALL rules strictly. Output ONLY valid JSON (no markdown).

── Table columns (exact keys, match order) ──
"entityType"           : LP / GP / Broker / Other      (choose one)
"firmName"             : official name
"subType"              : choose ≥1 from the fixed lists below
"address"              : full mailing address
"country"              : HQ country
"website"              : homepage URL
"companyLinkedIn"      : company LinkedIn URL
"about"                : 2-3 sentence description (your own words)
"investmentStrategy"   : AUM, sectors, stages, geography, ticket size
"sector"               : choose ≥1 from fixed GICS list
"sectorDetails"        : firm's exact niche wording
"stagePreference"      : choose ≥1 from fixed stage list
"contactName"          : leave blank (\"\" – contacts fetched later)
"designation"          :  \"\"
"linkedIn"             :  \"\"
"email"                :  \"\"
"contactNumber"        :  \"\"

Fixed sector list:
Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples,
Health Care, Financials, Information Technology, Communication Services,
Utilities, Real Estate, Sector Agnostic

Fixed stage list:
Pre-Seed / Incubation, Seed / Angel, Early VC (Series A),
Mid VC (Series B–C), Late VC / Pre-IPO, Growth Equity,
Buyout / Control, Special Situations / Distressed,
Private Debt / Mezzanine, Infrastructure / Real Assets,
Secondaries, Fund-of-Funds / Multi-Manager, Multi-Stage,
Other, Stage Agnostic

LP sub-types:
Endowment Fund, Sovereign Wealth Fund, Bank, Insurance Company, University,
Pension Fund, Economic Development Agency, Family Office, Foundation,
Wealth Management Firm, HNI, Hedge Fund, Fund of Funds, Other (specify)

GP sub-types:
Private Equity, Venture Capital, Angel Investors, Corporate Development Team,
Incubator, SBIC, Business Development Company, Growth Equity Firm, Accelerator,
Fund of Funds, Angel Group, Asset Management Firm, Angel Investment Fund,
Other (specify)

Broker definition: intermediary arranging capital without discretionary management.

Edge-cases & definitions:
Corporate VC → GP | Corporate Development Team
Placement / capital-intro only → Broker
Advisory without capital → Other

── Task ──
Return EXACTLY 5 firms that match:
• entityType = "${entityType}"
• specific type = "${subType}"
• sector focus = "${sector}"
• headquartered in or strongly linked to "${geo}"

For each firm:
1. verify with ≥2 public sources (website, filings, LinkedIn, press).
2. fill EVERY column as per rules.
3. choose sector / stage ONLY if explicitly stated by firm.

Output:
A pure JSON array of 5 objects using the column keys above.`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: ruleBook }] }],
      generationConfig: { responseMimeType: "application/json" }
    };

    /* ---------- call Gemini ---------- */
    const gRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
    );
    if (!gRes.ok)
      throw new Error(`Gemini status ${gRes.status}`);

    let text = (await gRes.json())?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    text = text.trim().replace(/^```json/i,"").replace(/```$/,"").trim();
    let firms;
    try { firms = JSON.parse(text); } catch { throw new Error("Gemini JSON parse fail"); }
    if (!Array.isArray(firms)) firms = [];

    /* ---------- make sure table exists ---------- */
    await DB.exec(
      "CREATE TABLE IF NOT EXISTS firms (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "website TEXT UNIQUE," +
      "firm_name TEXT," +
      "entity_type TEXT," +
      "sub_type TEXT," +
      "country TEXT," +
      "about TEXT," +
      "investment_strategy TEXT," +
      "sector TEXT," +
      "source TEXT," +
      "validated INTEGER DEFAULT 0," +
      "created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"
    );

    /* ---------- insert new firms, skip duplicates ---------- */
    const newArr = [];
    for (const f of firms) {
      const web = (f.website || "").toLowerCase();
      if (!web) continue;

      const exists = await DB.prepare("SELECT 1 FROM firms WHERE website = ? LIMIT 1").bind(web).first();
      if (exists) continue;

      await DB.prepare("INSERT INTO firms (website, firm_name, entity_type, sub_type, country, about, investment_strategy, sector, source) VALUES (?,?,?,?,?,?,?,?, 'Gemini')")
                .bind(web, f.firmName, entityType, f.subType, f.country, f.about, f.investmentStrategy, f.sector).run();

      newArr.push({ ...f, website: web });
    }

    return respond(newArr);
  } catch (e) {
    return respond({ error: e.message }, 500);
  }

  /* helper */
  function respond(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  }
}
