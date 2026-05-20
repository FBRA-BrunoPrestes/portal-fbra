export default async (request) => {
  // Only allow POST
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // CORS headers for same-site calls
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const { question, context } = await request.json();

    if (!question) {
      return new Response(JSON.stringify({ error: "Pergunta não informada." }), {
        status: 400, headers: corsHeaders
      });
    }

    const systemPrompt = `Você é o assistente de análise de dados do Portal FBRA da Fersa Brasil.
Responda SEMPRE em português do Brasil. Seja direto, objetivo e profissional.
Use os dados do portal para fundamentar suas respostas.
Quando citar números, seja preciso. Se não souber ou os dados não estiverem disponíveis, diga claramente.
Não invente dados — use apenas o que está no contexto fornecido abaixo.

============================================================
DADOS DO PORTAL FERSA BRASIL
============================================================

## COMPRAS (Backorder & Transit)
Colunas da tabela: Item ID | Catalog Nr. | ETA | Status | Origin | Qty | Brand
- Total de linhas: 5.212 pedidos
- Quantidade total: 1.169.868 unidades | Custo total: €3.595.656
- Por status:
  • Transit: 357.174 unidades | €992.079
  • Backorder: 812.694 unidades | €2.603.577
- Por marca:
  • FERSA: 129.049 unidades | €1.179.014
  • NKE: 206.178 unidades | €408.990
  • A&S: 494.339 unidades | €1.636.294
  • PFI: 340.302 unidades | €371.358
- Por origem:
  • China: 1.143.219 unidades | €3.027.288
  • Spain: 20.092 unidades | €447.936
  • Austria: 4.320 unidades | €26.645
  • India: 2.237 unidades | €93.788

## SALES FILL RATE
Colunas da tabela: Item ID | Catalog | Brand | Period | Intake | Filled | Pending | Fill rate
- Total de linhas: 26.241 registros
- Intake total: 2.981.033 unidades
- Filled total: 599.662 unidades
- Pending total: 1.509.296 unidades
- Fill rate global: 20,1%

## FORECAST ACCURACY
- Total de vendas: 217.585 unidades
- Total de forecast: 215.652 unidades
- Itens com forecast OK (±20%): 144 de 4.471 (3,2%)
- Qty vendida com forecast OK: 14.616 unidades
- Qty forecast OK: 15.342 unidades
- % qty hit vs forecast: 6,8%
- Itens Out of Forecast: 1.130
- Vendas Out of Forecast: 31.932 unidades
- % OOF vs vendas totais: 14,8%
- Top 20 itens sem vendas mas com forecast: inclui NB-148 (PFI, forecast 30.893 un, stock 0)
- Top 20 itens Out of Forecast: inclui AAS NKE_6000-2Z (vendas 5.700 un)

## STOCK & SALES
Módulo de navegação para sub-dashboards:
- Forecast Accuracy: comparação forecast vs vendas reais
- Sales Fill Rate: taxa de atendimento de pedidos vs demanda

## SUMMARY (Revenue & Budget)
Módulo em desenvolvimento — dados não disponíveis ainda.

============================================================
${context ? `\nCONTEXTO ADICIONAL DA SESSÃO:\n${context}` : ""}`;

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
      return new Response(JSON.stringify({ error: "Erro na API Claude: " + errText }), {
        status: 502, headers: corsHeaders
      });
    }

    const data = await response.json();
    const answer = data.content?.[0]?.text ?? "Não foi possível obter resposta.";

    return new Response(JSON.stringify({ answer }), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Erro interno: " + err.message }), {
      status: 500, headers: corsHeaders
    });
  }
};
