/**
 * Netlify Function: chat.js
 * Path in your repo: netlify/functions/chat.js
 *
 * What this file does:
 *  1. Fetches all portal CSVs from GitHub on every request (server-side).
 *  2. Parses and injects ALL rows into the Claude system prompt.
 *  3. Passes the full conversation history so Claude remembers context.
 *
 * To add the sales_fill_rate.csv: uncomment the block in CSV_SOURCES below.
 */

// ── CSV sources ──────────────────────────────────────────────────────────────
const CSV_SOURCES = [
  {
    key: 'purchases',
    label: 'Purchases (backorders & transit)',
    url: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/purchases.csv',
  },
  {
    key: 'summary',
    label: 'Summary (revenue vs budget by brand)',
    url: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/summary.csv',
  },
  {
    key: 'sales_fill_rate',
    label: 'Sales Fill Rate',
    url: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/sales_fill_rate.csv',
  },
];

// ── CSV parser (semicolon-separated) ─────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(';').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(';').map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}

// ── Fetch one CSV ─────────────────────────────────────────────────────────────
async function fetchCSV(source) {
  try {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const { headers, rows } = parseCSV(text);
    return { key: source.key, label: source.label, headers, rows, error: null };
  } catch (err) {
    console.error('[chat.js] Failed to fetch ' + source.key + ':', err.message);
    return { key: source.key, label: source.label, headers: [], rows: [], error: err.message };
  }
}

// ── Convert dataset to compact text for the prompt ───────────────────────────
function datasetToText({ label, headers, rows, error }) {
  if (error)         return '## ' + label + '\n[ERROR loading data: ' + error + ']\n';
  if (rows.length === 0) return '## ' + label + '\n[No data available]\n';

  const headerLine = headers.join(';');
  const dataLines  = rows.map(row => headers.map(h => row[h] ?? '').join(';'));

  return [
    '## ' + label,
    'Columns: ' + headerLine,
    'Total rows: ' + rows.length,
    '',
    dataLines.join('\n'),
    '',
  ].join('\n');
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function (event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { question, history = [] } = body;

  if (!question && history.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No question provided' }) };
  }

  // Fetch all CSVs in parallel
  const datasets  = await Promise.all(CSV_SOURCES.map(fetchCSV));
  const dataBlock = datasets.map(datasetToText).join('\n---\n\n');

  const systemPrompt = `
You are the AI data assistant for the Fersa FBRA internal portal.
Answer in the same language the user writes in (Portuguese or English).
Be concise, direct and data-driven. Always cite specific figures when available.
If data is not present, say so clearly — never invent values.

## Your capabilities
You have access to LIVE portal data fetched directly from the source files at request time.
You can answer questions such as:
- Total backorder or transit quantities (overall or filtered by product, brand, origin, month, etc.)
- Specific product lookup: "How many units of AAS 30210 F are in transit?"
- Revenue vs budget by brand
- Possible future sales by period
- Any filter or aggregation the user requests

## How to answer detail questions
- To find a specific product: match by catalog_nr or item_id in the purchases data.
- To calculate totals: sum the qty column, filtering by status = "Transit" or "Backorder" as needed.
- For revenue questions: use the summary data.
- For follow-up questions: use the conversation history already in the messages.

## Rules
- Never invent or approximate data. Only use the values provided below.
- If a product is not found, say: "I couldn't find that reference in the current data."
- Format numbers clearly. Show breakdown when summing multiple rows.

---

# LIVE PORTAL DATA
(Fetched at request time from GitHub source files)

${dataBlock}
`.trim();

  // Use full history for context (FIX 1), fallback to single question
  const messages = history.length > 0
    ? history
    : [{ role: 'user', content: question }];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[chat.js] Anthropic API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'Upstream API error. Please try again.' }) };
    }

    const data   = await response.json();
    const answer = data?.content?.[0]?.text ?? 'No response received.';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    };

  } catch (err) {
    console.error('[chat.js] Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};
