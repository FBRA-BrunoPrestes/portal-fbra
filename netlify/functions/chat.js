/**
 * Netlify Function: chat.js
 * Path in your repo: netlify/functions/chat.js
 *
 * Strategy: on-demand search
 *  1. First call to Claude (tiny prompt): extract filters from the user question.
 *  2. Filter CSVs locally on the server using those filters.
 *  3. Second call to Claude: answer the question using only the relevant rows.
 */

const CSV_SOURCES = {
  purchases: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/purchases.csv',
  summary:   'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/summary.csv',
  sales_fill_rate: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/sales_fill_rate.csv',
  stock:     'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/stock.csv',
  sales_backorders: 'https://raw.githubusercontent.com/FBRA-BrunoPrestes/portal-fbra/refs/heads/main/netlify/data/sales_backorders.csv',
};

// Different exports use different header spellings for the same concept
// (e.g. "Catalog Nr." vs "catalog_nr", "Item ID" vs "item_id"). Normalise
// the key columns to canonical snake_case so filtering works uniformly
// across every dataset. Unmapped columns are kept untouched.
const HEADER_ALIASES = {
  'item id': 'item_id',
  'item_id': 'item_id',
  'catalog nr.': 'catalog_nr',
  'catalog nr': 'catalog_nr',
  'catalog': 'catalog_nr',
  'catalog_nr': 'catalog_nr',
  'brand': 'brand',
  'qty': 'qty',
  'quantity': 'qty',
  'status': 'status',
  'origin': 'origin',
  'month': 'month',
};
function canonicalHeader(h) {
  return HEADER_ALIASES[String(h).trim().toLowerCase()] || String(h).trim();
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  // Map raw headers → canonical keys (key columns) while preserving others.
  const headers = lines[0].split(';').map(h => canonicalHeader(h));
  const rows = lines.slice(1).map(line => {
    const values = line.split(';').map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
  return { headers, rows };
}

async function fetchCSV(key) {
  try {
    const res = await fetch(CSV_SOURCES[key]);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return parseCSV(text);
  } catch (err) {
    console.error('[chat.js] Failed to fetch ' + key + ':', err.message);
    return { headers: [], rows: [] };
  }
}

// ── Claude API call helper ────────────────────────────────────────────────────
async function callClaude(systemPrompt, messages, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error('API ' + response.status + ': ' + err);
  }
  const data = await response.json();
  const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text') : null;
  return textBlock && typeof textBlock.text === 'string' ? textBlock.text : '';
}

// ── Step 1: extract intent and filters from the question ─────────────────────
async function extractFilters(question, history) {
  const systemPrompt = `You extract search filters from a user question about a purchases/stock portal.
Return ONLY a valid JSON object with these fields (all optional):
{
  "datasets": ["purchases", "stock", "sales_backorders", "summary", "sales_fill_rate"],  // which datasets are needed
  "catalog_nr": "partial product name or reference to search for",
  "brand": "FERSA or NKE or PFI or A&S",
  "status": "Transit or Backorder",
  "origin": "China or Spain or Austria",
  "month": "JAN/FEB/MAR/APR/MAY/JUN/JUL/AUG/SEP/OCT/NOV/DEC",
  "is_total": true,   // true if user wants an overall total (no specific product)
  "is_summary": true  // true if question is about revenue/budget/sales forecast
}

Dataset guide (pick every dataset the question needs):
- "stock": on-hand inventory / current stock ("quanto temos em estoque", "stock on hand", "peças em estoque"). Stock lives ONLY here, never in purchases.
- "purchases": incoming arrivals / transit / purchase backorder (ETA, invoices, in transit, chegadas).
- "sales_backorders": open sales backorder (customer demand not yet served).
- "summary": revenue vs budget / sales forecast.
- "sales_fill_rate": intake vs on-time delivery / fill rate.
A stock question about a specific product (e.g. "quantas peças em estoque do PF110390") → datasets ["stock"] with catalog_nr "PF110390". If it also asks about arrivals or balance, add "purchases" and/or "sales_backorders".

Only include fields that are clearly mentioned or implied. No explanation, only JSON.`;

  // Use last 2 turns of history for context (keeps this call tiny).
  // `history` already ends with the current user turn (the frontend pushes
  // it before sending), so don't append `question` again — that produced
  // two consecutive "user" messages, which the API rejects.
  const recentHistory = history.slice(-4);
  const messages = recentHistory.length > 0
    ? recentHistory
    : [{ role: 'user', content: question }];

  try {
    const raw = await callClaude(systemPrompt, messages, 200);
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[chat.js] Filter extraction failed:', e.message);
    // Fallback: fetch purchases only, no filters
    return { datasets: ['purchases'], is_total: true };
  }
}

// ── Step 2: filter rows locally ───────────────────────────────────────────────
function filterRows(rows, filters) {
  return rows.filter(row => {
    if (filters.catalog_nr) {
      const search = filters.catalog_nr.toLowerCase();
      if (!(row['catalog_nr'] || '').toLowerCase().includes(search)) return false;
    }
    if (filters.brand) {
      if ((row['brand'] || '').toUpperCase() !== filters.brand.toUpperCase()) return false;
    }
    if (filters.status) {
      if ((row['status'] || '').toLowerCase() !== filters.status.toLowerCase()) return false;
    }
    if (filters.origin) {
      if ((row['origin'] || '').toLowerCase() !== filters.origin.toLowerCase()) return false;
    }
    if (filters.month) {
      if ((row['month'] || '').toUpperCase() !== filters.month.toUpperCase()) return false;
    }
    return true;
  });
}

// Stock and sales-backorder files only carry item_id / catalog_nr / brand /
// qty, so only those filters apply. Applying status/origin/month here (which
// don't exist in these files) would wrongly drop every row.
function filterStockRows(rows, filters) {
  return rows.filter(row => {
    if (filters.catalog_nr) {
      const search = filters.catalog_nr.toLowerCase();
      const cat = (row['catalog_nr'] || '').toLowerCase();
      const id  = (row['item_id'] || '').toLowerCase();
      if (!cat.includes(search) && !id.includes(search)) return false;
    }
    if (filters.brand) {
      if ((row['brand'] || '').toUpperCase() !== filters.brand.toUpperCase()) return false;
    }
    return true;
  });
}

// Summarise a stock / backorder dataset for the answer prompt: total qty,
// plus per-code rows when a specific product was requested (few rows), or a
// per-brand breakdown for overall queries (avoids dumping thousands of rows).
function stockBlock(label, headers, rows, filters) {
  const filtered = filterStockRows(rows, filters);
  if (filtered.length === 0) return label + ': no matching rows found.';
  const totalQty = filtered.reduce((s, r) => s + (parseInt(r['qty']) || 0), 0);
  if (filters.catalog_nr && filtered.length <= 60) {
    return label + ' — total qty ' + totalQty + ' across ' + filtered.length +
      ' code(s):\n' + rowsToText(headers, filtered, 'Rows');
  }
  const byBrand = {};
  filtered.forEach(r => {
    const b = r['brand'] || '—';
    byBrand[b] = (byBrand[b] || 0) + (parseInt(r['qty']) || 0);
  });
  const brandLines = Object.entries(byBrand).map(([b, q]) => '  ' + b + ': ' + q).join('\n');
  return label + ' — total qty ' + totalQty + ' across ' + filtered.length +
    ' code(s)\nBy brand:\n' + brandLines;
}

// ── Format filtered rows as compact CSV text ──────────────────────────────────
function rowsToText(headers, rows, label) {
  if (rows.length === 0) return label + ': no matching rows found.';
  const lines = [headers.join(';')];
  rows.forEach(row => lines.push(headers.map(h => row[h] || '').join(';')));
  return label + ' (' + rows.length + ' rows):\n' + lines.join('\n');
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

  try {
    // ── Step 1: extract filters (tiny call, ~300 tokens) ───────────────────
    const filters = await extractFilters(question, history);
    console.log('[chat.js] Filters:', JSON.stringify(filters));

    // ── Step 2: fetch and filter only the needed datasets ─────────────────
    const dataParts = [];
    const needed = filters.datasets || ['purchases'];

    if (needed.includes('purchases')) {
      const { headers, rows } = await fetchCSV('purchases');
      if (rows.length > 0) {
        const filtered = filters.is_total ? rows : filterRows(rows, filters);
        // For totals, compress to summary stats instead of all rows
        if (filters.is_total) {
          const transit   = rows.filter(r => r['status'] === 'Transit').reduce((s, r) => s + (parseInt(r['qty']) || 0), 0);
          const backorder = rows.filter(r => r['status'] === 'Backorder').reduce((s, r) => s + (parseInt(r['qty']) || 0), 0);
          const brands    = [...new Set(rows.map(r => r['brand']))];
          dataParts.push('## Purchases — Overall totals\nTotal Transit qty: ' + transit + '\nTotal Backorder qty: ' + backorder + '\nBrands: ' + brands.join(', '));
        } else {
          dataParts.push(rowsToText(headers, filtered, '## Purchases'));
        }
      }
    }

    if (needed.includes('stock')) {
      const { headers, rows } = await fetchCSV('stock');
      if (rows.length > 0) {
        dataParts.push(stockBlock('## Stock on hand', headers, rows, filters));
      }
    }

    if (needed.includes('sales_backorders')) {
      const { headers, rows } = await fetchCSV('sales_backorders');
      if (rows.length > 0) {
        dataParts.push(stockBlock('## Sales backorder (open customer demand)', headers, rows, filters));
      }
    }

    if (needed.includes('summary')) {
      const { headers, rows } = await fetchCSV('summary');
      if (rows.length > 0) {
        dataParts.push(rowsToText(headers, rows, '## Summary (revenue vs budget)'));
      }
    }

    if (needed.includes('sales_fill_rate')) {
      const { headers, rows } = await fetchCSV('sales_fill_rate');
      if (rows.length > 0) {
        const filtered = filters.brand
          ? rows.filter(r => (r['brand'] || '').toUpperCase() === filters.brand.toUpperCase())
          : rows;
        dataParts.push(rowsToText(headers, filtered, '## Sales Fill Rate'));
      }
    }

    const dataBlock = dataParts.join('\n\n---\n\n');

    // ── Step 3: answer call with filtered data ─────────────────────────────
    const systemPrompt = `You are the AI data assistant for the Fersa FBRA internal portal.
Answer in the same language the user writes in (Portuguese or English).
Be concise and data-driven. Always cite specific figures. Never invent values.
If a product is not found in the data, say so clearly.
Use the conversation history for follow-up context.

---
# RELEVANT PORTAL DATA (pre-filtered for this question)

${dataBlock}`.trim();

    const messages = history.length > 0
      ? history
      : [{ role: 'user', content: question }];

    const answer = await callClaude(systemPrompt, messages, 1024);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    };

  } catch (err) {
    console.error('[chat.js] Error:', err.message);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
