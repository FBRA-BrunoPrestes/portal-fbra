export default async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const { question, context } = await request.json();

    if (!question) {
      return new Response(JSON.stringify({ error: "No question provided." }), {
        status: 400, headers: corsHeaders
      });
    }

    const systemPrompt = `You are the data analysis assistant for the FBRA Fersa Brasil Portal.
Always respond in English. Be direct, objective and professional.
Use the portal data below to support your answers.
When citing numbers, be precise. If you don't know or the data is not available, say so clearly.
Do not make up data — use only what is provided in the context below.

============================================================
FERSA BRASIL PORTAL DATA
============================================================

## PURCHASES (Backorder & Transit)
Table columns: Item ID | Catalog Nr. | ETA | Status | Origin | Qty | Brand
- Total rows: 5,212 orders
- Total quantity: 1,169,868 units | Total cost: €3,595,656
- By status:
  • Transit: 357,174 units | €992,079
  • Backorder: 812,694 units | €2,603,577
- By brand:
  • FERSA: 129,049 units | €1,179,014
  • NKE: 206,178 units | €408,990
  • A&S: 494,339 units | €1,636,294
  • PFI: 340,302 units | €371,358
- By origin:
  • China: 1,143,219 units | €3,027,288
  • Spain: 20,092 units | €447,936
  • Austria: 4,320 units | €26,645
  • India: 2,237 units | €93,788

## SALES FILL RATE
Table columns: Item ID | Catalog | Brand | Period | Intake | Filled | Pending | Fill rate
- Total rows: 26,241 records
- Total intake qty: 2,981,033 units
- Total filled qty: 599,662 units
- Total pending qty: 1,509,296 units
- Overall fill rate: 20.1%

## FORECAST ACCURACY
- Total sales qty: 217,585 units
- Total forecast qty: 215,652 units
- Items within forecast (±20%): 144 out of 4,471 (3.2%)
- Sales qty within forecast: 14,616 units
- Forecast qty within range: 15,342 units
- % qty hit vs forecast: 6.8%
- Out-of-forecast items: 1,130
- Out-of-forecast sales: 31,932 units
- % OOF vs total sales: 14.8%
- Top 20 items with no sales but with forecast: includes NB-148 (PFI, forecast 30,893 units, stock 0)
- Top 20 out-of-forecast items: includes AAS NKE_6000-2Z (sales 5,700 units)

## STOCK & SALES
Navigation module for sub-dashboards:
- Forecast Accuracy: forecast vs actual sales comparison
- Sales Fill Rate: order fulfilment rate vs customer demand

## SUMMARY (Revenue & Budget)
Module under development — data not yet available.

============================================================
${context ? `\nADDITIONAL SESSION CONTEXT:\n${context}` : ""}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: question }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: "Claude API error: " + errText }), {
        status: 502, headers: corsHeaders
      });
    }

    const data = await response.json();
    const answer = data.content?.[0]?.text ?? "Unable to get a response.";

    return new Response(JSON.stringify({ answer }), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal error: " + err.message }), {
      status: 500, headers: corsHeaders
    });
  }
};
