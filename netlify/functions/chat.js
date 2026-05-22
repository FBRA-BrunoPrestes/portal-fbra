/**
 * Netlify Function: chat.js
 * Path in your repo: netlify/functions/chat.js
 */

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

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(';').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(';').map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
  return { headers, rows };
}

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

// Purchases: group by product to reduce token usage (~90% smaller)
function compressPurchases(rows) {
  const map = {};
  for (const row of rows) {
    const key = (row['catalog_nr'] || '') + '||' + (row['brand'] || '') + '||' + (row['origin'] || '');
    if (!map[key]) {
      map[key] = {
        catalog_nr: row['catalog_nr'] || '',
        brand:      row['brand'] || '',
        origin:     row['origin'] || '',
        transit:    0,
        backorder:  0,
        next_eta:   row['eta'] || '',
      };
    }
    const qty = parseInt(row['qty']) || 0;
    if (row['status'] === 'Transit')   map[key].transit   += qty;
    if (row['status'] === 'Backorder') map[key].backorder += qty;
    if (row['eta'] && (!map[key].next_eta || row['eta'] < map[key].next_eta)) {
      map[key].next_eta = row['eta'];
    }
  }
  const lines = ['catalog_nr;brand;origin;transit_qty;backorder_qty;next_eta'];
  for (const r of Object.values(map)) {
    lines.push([r.catalog_nr, r.brand, r.origin, r.transit, r.backorder, r.next_eta].join(';'));
  }
  return lines.join('\n');
}

function datasetToText(dataset) {
  const key   = dataset.key;
  const label = dataset.label;
  const rows  = dataset.rows;
  const headers = dataset.headers;
  const error = dataset.error;

  if (error)             return '## ' + label + '\n[ERROR: ' + error + ']\n';
  if (rows.length === 0) return '## ' + label + '\n[No data available]\n';

  if (key === 'purchases') {
    const productCount = new Set(rows.map(r => r['catalog_nr'])).size;
    return [
      '## ' + label,
      'Grouped by product. Format: catalog_nr;brand;origin;transit_qty;backorder_qty;next_eta',
      'Unique products: ' + productCount + ' | Total lines in source: ' + rows.length,
      '',
      compressPurchases(rows),
      '',
    ].join('\n');
  }

  const headerLine = headers.join(';');
  const dataLines  = rows.map(row => headers.map(h => row[h] || '').join(';'));
  return [
    '## ' + label,
    'Columns: ' + headerLine,
    'Rows: ' + rows.length,
    '',
    dataLines.join('\n'),
    '',
  ].join('\n');
}

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

  const datasets  = await Promise.all(CSV_SOURCES.map(fetchCSV));
  const dataBlock = datasets.map(datasetToText).join('\n---\n\n');

  const systemPrompt = `You are the AI data assistant for the Fersa FBRA internal portal.
Answer in the same language the user writes in (Portuguese or English).
Be concise and data-driven. Always cite specific figures. Never invent values.

You have access to LIVE portal data below (fetched at request time).
You can answer:
- Transit or backorder qty for any product or brand (use transit_qty / backorder_qty columns)
- Revenue vs budget by brand (use summary data)
- Comparisons, totals, filters by brand, origin, month, etc.
- Follow-up questions using the conversation history in the messages

If a product is not found, say so clearly. Format numbers clearly.

---
# LIVE PORTAL DATA

${dataBlock}`.trim();

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
      return { statusCode: 502, body: JSON.stringify({ error: 'Anthropic API error ' + response.status + ': ' + errText }) };
    }

    const data   = await response.json();
    const answer = data && data.content && data.content[0] ? data.content[0].text : 'No response received.';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    };

  } catch (err) {
    console.error('[chat.js] Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error: ' + err.message }) };
  }
};
