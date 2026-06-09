/**
 * Pricing Risk MCP Server — Raw Protocol Implementation
 * 
 * Implements the MCP (Model Context Protocol) JSON-RPC 2.0 spec directly.
 * No SDK transport dependencies — maximum reliability.
 * 
 * Supports: Streamable HTTP (POST /) and SSE (/sse + /messages)
 * 
 * Tools:
 *   get_fx_rates        — Live FX rates from ECB (Frankfurter API)
 *   get_inflation_data   — Country CPI from World Bank
 *   get_commodity_prices — Commodity indices from World Bank
 */

import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────────

async function getFxRates(args) {
  const currencies = args.currencies || "INR,EUR,CNY,GBP";
  const data = await fetchJSON(
    `https://api.frankfurter.app/latest?from=USD&to=${currencies}`
  );

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const dateStr = oneYearAgo.toISOString().split("T")[0];
  const historical = await fetchJSON(
    `https://api.frankfurter.app/${dateStr}?from=USD&to=${currencies}`
  );

  const changes = {};
  for (const [cur, rate] of Object.entries(data.rates)) {
    const old = historical.rates[cur];
    if (old) {
      const pct = ((rate - old) / old * 100).toFixed(2);
      changes[cur] = {
        current_rate: rate,
        rate_12_months_ago: old,
        change_percent: parseFloat(pct),
        direction: pct > 0 ? "USD strengthened" : "USD weakened",
      };
    }
  }

  return {
    source: "European Central Bank via Frankfurter API",
    base: "USD",
    date: data.date,
    rates: data.rates,
    twelve_month_changes: changes,
  };
}

async function getInflationData(args) {
  const cc = args.country_code || "USA";
  const url = `https://api.worldbank.org/v2/country/${cc}/indicator/FP.CPI.TOTL.ZG?format=json&date=2019:2026&per_page=10`;
  const raw = await fetchJSON(url);

  const points = (raw[1] || [])
    .filter((d) => d.value !== null)
    .map((d) => ({ year: d.date, cpi_percent: parseFloat(d.value.toFixed(2)) }))
    .sort((a, b) => b.year - a.year);

  const country = raw[1]?.[0]?.country?.value || cc;
  const latest = points[0];

  let risk = "LOW";
  if (latest?.cpi_percent > 10) risk = "CRITICAL";
  else if (latest?.cpi_percent > 6) risk = "HIGH";
  else if (latest?.cpi_percent > 3) risk = "MODERATE";

  return {
    source: "World Bank Open Data",
    country,
    country_code: cc,
    latest_cpi: latest || "No data",
    trend: points.slice(0, 6),
    risk_level: risk,
    interpretation: `${country} CPI: ${latest?.cpi_percent ?? "N/A"}% — ${risk} risk`,
  };
}

async function getCommodityPrices(args) {
  const group = args.commodity_group || "all";
  const indicators = {
    metals: { code: "CMETAL", name: "Metals & Minerals Price Index" },
    energy: { code: "CENERGY", name: "Energy Price Index" },
  };

  const groups = group === "all" ? ["metals", "energy"] : [group];
  const results = {};

  for (const g of groups) {
    const ind = indicators[g];
    if (!ind) continue;
    const url = `https://api.worldbank.org/v2/country/WLD/indicator/${ind.code}?format=json&date=2019:2026&per_page=10`;
    const raw = await fetchJSON(url);

    const points = (raw[1] || [])
      .filter((d) => d.value !== null)
      .map((d) => ({ year: d.date, index: parseFloat(d.value.toFixed(2)) }))
      .sort((a, b) => b.year - a.year);

    const latest = points[0];
    const prev = points[1];
    const yoy = latest && prev
      ? parseFloat(((latest.index - prev.index) / prev.index * 100).toFixed(2))
      : null;

    results[g] = {
      name: ind.name,
      latest: latest || "No data",
      previous: prev || "No data",
      yoy_change_percent: yoy,
      direction: yoy > 0 ? "RISING" : yoy < 0 ? "FALLING" : "STABLE",
      trend: points.slice(0, 6),
    };
  }

  return { source: "World Bank Commodity Markets", base: "2010=100", commodities: results };
}

// ─────────────────────────────────────────────────
// MCP PROTOCOL: Tool definitions
// ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_fx_rates",
    description: "Get live foreign exchange rates from the European Central Bank. Returns current USD rates and 12-month changes for INR, EUR, CNY, GBP. Use to assess currency exposure risk.",
    inputSchema: {
      type: "object",
      properties: {
        currencies: {
          type: "string",
          description: "Comma-separated currencies, e.g. 'INR,EUR,CNY,GBP'",
          default: "INR,EUR,CNY,GBP",
        },
      },
    },
  },
  {
    name: "get_inflation_data",
    description: "Get official CPI inflation rate for a country from the World Bank. Returns annual CPI % for recent years. Use codes: USA, IND (India), DEU (Germany), CHN (China), GBR (UK).",
    inputSchema: {
      type: "object",
      properties: {
        country_code: {
          type: "string",
          description: "ISO 3-letter code: USA, IND, DEU, CHN, GBR, IRL, SGP, PHL",
        },
      },
      required: ["country_code"],
    },
  },
  {
    name: "get_commodity_prices",
    description: "Get global commodity price indices from the World Bank. Returns metals and energy price index values (2010=100) with year-over-year trends. Use to assess raw material cost volatility.",
    inputSchema: {
      type: "object",
      properties: {
        commodity_group: {
          type: "string",
          enum: ["metals", "energy", "all"],
          description: "'metals' for hardware, 'energy' for logistics, 'all' for both",
          default: "all",
        },
      },
    },
  },
];

const TOOL_HANDLERS = {
  get_fx_rates: getFxRates,
  get_inflation_data: getInflationData,
  get_commodity_prices: getCommodityPrices,
};

// ─────────────────────────────────────────────────
// MCP PROTOCOL: JSON-RPC 2.0 message handler
// ─────────────────────────────────────────────────

const sessions = {};

function makeResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcpMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return makeResponse(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "pricing-risk-data", version: "1.0.0" },
        capabilities: { tools: {} },
      });

    case "notifications/initialized":
      return null; // notification, no response

    case "ping":
      return makeResponse(id, {});

    case "tools/list":
      return makeResponse(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return makeError(id, -32602, `Unknown tool: ${toolName}`);
      }
      try {
        const result = await handler(params.arguments || {});
        return makeResponse(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return makeResponse(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// ─────────────────────────────────────────────────
// STREAMABLE HTTP TRANSPORT (POST /, POST /mcp)
// ─────────────────────────────────────────────────

async function handlePost(req, res) {
  // Handle session
  let sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    sessionId = randomUUID();
  }
  sessions[sessionId] = true;

  const body = req.body;

  // Handle batch requests
  if (Array.isArray(body)) {
    const responses = [];
    for (const msg of body) {
      const resp = await handleMcpMessage(msg);
      if (resp) responses.push(resp);
    }
    res.setHeader("mcp-session-id", sessionId);
    res.json(responses.length === 1 ? responses[0] : responses);
    return;
  }

  // Single message
  const response = await handleMcpMessage(body);
  if (response) {
    res.setHeader("mcp-session-id", sessionId);
    res.json(response);
  } else {
    res.setHeader("mcp-session-id", sessionId);
    res.status(202).end();
  }
}

app.post("/", handlePost);
app.post("/mcp", handlePost);

// ─────────────────────────────────────────────────
// SSE TRANSPORT (/sse + /messages)
// ─────────────────────────────────────────────────

const sseClients = {};

app.get("/sse", (req, res) => {
  const sessionId = randomUUID();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send the endpoint URI for the client to POST messages to
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  sseClients[sessionId] = res;

  req.on("close", () => {
    delete sseClients[sessionId];
  });
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const sseRes = sseClients[sessionId];

  if (!sseRes) {
    res.status(400).json({ error: "Unknown session. Connect to /sse first." });
    return;
  }

  const response = await handleMcpMessage(req.body);

  if (response) {
    // Send response via SSE
    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  }

  res.status(202).end();
});

// ─────────────────────────────────────────────────
// HEALTH CHECK & DELETE
// ─────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "pricing-risk-data",
    version: "1.0.0",
    tools: TOOLS.map((t) => t.name),
    transports: ["streamable-http (POST / or /mcp)", "sse (GET /sse)"],
  });
});

// Handle GET on root (browser visit) — return health info
app.get("/", (req, res) => {
  // Check if this is an MCP SSE request or a browser
  if (req.headers.accept?.includes("text/event-stream")) {
    // Redirect to /sse for SSE clients
    res.redirect(307, "/sse");
    return;
  }
  res.json({
    status: "ok",
    server: "pricing-risk-data MCP Server",
    description: "Connect via MCP protocol (POST /) or SSE (GET /sse)",
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  });
});

app.delete("/", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) delete sessions[sessionId];
  res.status(200).end();
});

app.delete("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) delete sessions[sessionId];
  res.status(200).end();
});

// ─────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pricing Risk MCP Server running on port ${PORT}`);
});
