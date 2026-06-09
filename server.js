/**
 * Pricing Risk MCP Server
 * 
 * Wraps free financial APIs and exposes them via MCP protocol for GEP QI.
 * Supports BOTH Streamable HTTP and SSE transports for maximum compatibility.
 * Listens at root "/" and "/mcp" for Streamable HTTP, and "/sse" for SSE.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";

// ─────────────────────────────────────────────────
// Helper: fetch JSON from a URL
// ─────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API returned ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─────────────────────────────────────────────────
// Register all tools on a server instance
// ─────────────────────────────────────────────────
function registerTools(server) {

  // ═══════════════════════════════════════════════
  // TOOL 1: get_fx_rates
  // ═══════════════════════════════════════════════
  server.tool(
    "get_fx_rates",
    "Get live foreign exchange rates from the European Central Bank. Returns current USD conversion rates and 12-month change for currency exposure risk assessment.",
    {
      currencies: z
        .string()
        .default("INR,EUR,CNY,GBP")
        .describe("Comma-separated target currencies, e.g. 'INR,EUR,CNY,GBP'"),
    },
    async ({ currencies }) => {
      try {
        const data = await fetchJSON(
          `https://api.frankfurter.app/latest?from=USD&to=${currencies}`
        );

        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const dateStr = oneYearAgo.toISOString().split("T")[0];

        const historicalData = await fetchJSON(
          `https://api.frankfurter.app/${dateStr}?from=USD&to=${currencies}`
        );

        const changes = {};
        for (const [currency, currentRate] of Object.entries(data.rates)) {
          const oldRate = historicalData.rates[currency];
          if (oldRate) {
            const changePct = ((currentRate - oldRate) / oldRate * 100).toFixed(2);
            changes[currency] = {
              current_rate: currentRate,
              rate_12_months_ago: oldRate,
              change_percent: parseFloat(changePct),
              direction: changePct > 0
                ? "USD strengthened (supplier currency weakened)"
                : "USD weakened (supplier currency strengthened)",
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "European Central Bank via Frankfurter API",
              base_currency: "USD",
              current_date: data.date,
              historical_date: historicalData.date,
              current_rates: data.rates,
              twelve_month_changes: changes,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching FX rates: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════
  // TOOL 2: get_inflation_data
  // ═══════════════════════════════════════════════
  server.tool(
    "get_inflation_data",
    "Get official CPI inflation rate for a country from the World Bank. Returns annual inflation percentages for recent years. Country codes: USA, IND (India), DEU (Germany), CHN (China), GBR (UK).",
    {
      country_code: z
        .string()
        .describe("ISO 3-letter country code: USA, IND, DEU, CHN, GBR, IRL, SGP, PHL"),
    },
    async ({ country_code }) => {
      try {
        const cpiUrl = `https://api.worldbank.org/v2/country/${country_code}/indicator/FP.CPI.TOTL.ZG?format=json&date=2020:2026&per_page=10`;
        const cpiRaw = await fetchJSON(cpiUrl);

        const cpiData = (cpiRaw[1] || [])
          .filter((d) => d.value !== null)
          .map((d) => ({ year: d.date, cpi_percent: parseFloat(d.value.toFixed(2)) }))
          .sort((a, b) => b.year - a.year);

        const countryName = cpiRaw[1]?.[0]?.country?.value || country_code;
        const latestCpi = cpiData[0];

        let inflationRisk = "LOW";
        if (latestCpi && latestCpi.cpi_percent > 10) inflationRisk = "CRITICAL";
        else if (latestCpi && latestCpi.cpi_percent > 6) inflationRisk = "HIGH";
        else if (latestCpi && latestCpi.cpi_percent > 3) inflationRisk = "MODERATE";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "World Bank Open Data",
              country: countryName,
              country_code,
              latest_cpi: latestCpi || "No data available",
              cpi_trend: cpiData.slice(0, 5),
              inflation_risk_level: inflationRisk,
              interpretation: `${countryName} CPI is ${latestCpi?.cpi_percent ?? "N/A"}% (${inflationRisk} risk). Compare against supplier contract escalation cap.`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching inflation data: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════
  // TOOL 3: get_commodity_prices
  // ═══════════════════════════════════════════════
  server.tool(
    "get_commodity_prices",
    "Get global commodity price indices from the World Bank. Returns index values (2010=100) for metals and energy. Use to assess raw material cost volatility.",
    {
      commodity_group: z
        .enum(["metals", "energy", "all"])
        .default("all")
        .describe("'metals' for hardware, 'energy' for logistics, or 'all'"),
    },
    async ({ commodity_group }) => {
      try {
        const indicators = {
          metals: { code: "CMETAL", name: "Metals & Minerals Price Index" },
          energy: { code: "CENERGY", name: "Energy Price Index" },
        };

        const groups = commodity_group === "all"
          ? Object.keys(indicators)
          : [commodity_group];

        const results = {};

        for (const group of groups) {
          const ind = indicators[group];
          const url = `https://api.worldbank.org/v2/country/WLD/indicator/${ind.code}?format=json&date=2020:2026&per_page=10`;
          const raw = await fetchJSON(url);

          const dataPoints = (raw[1] || [])
            .filter((d) => d.value !== null)
            .map((d) => ({ year: d.date, index_value: parseFloat(d.value.toFixed(2)) }))
            .sort((a, b) => b.year - a.year);

          const latest = dataPoints[0];
          const previous = dataPoints[1];
          let yoyChange = null;
          if (latest && previous) {
            yoyChange = parseFloat(((latest.index_value - previous.index_value) / previous.index_value * 100).toFixed(2));
          }

          results[group] = {
            indicator_name: ind.name,
            latest: latest || "No data",
            previous: previous || "No data",
            year_over_year_change_percent: yoyChange,
            trend: dataPoints.slice(0, 5),
            direction: yoyChange > 0 ? "RISING" : yoyChange < 0 ? "FALLING" : "STABLE",
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "World Bank Commodity Markets",
              base_index: "2010 = 100",
              commodities: results,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching commodity prices: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ─────────────────────────────────────────────────
// Create a fresh server instance with tools
// ─────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "pricing-risk-data",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

// ─────────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── Streamable HTTP Transport ───
// Store active transports by session ID
const httpTransports = {};

async function handleStreamableHTTP(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && httpTransports[sessionId]) {
    // Existing session
    await httpTransports[sessionId].handleRequest(req, res);
  } else if (req.method === "POST") {
    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = createMcpServer();
    await server.connect(transport);

    // Save transport after connection (session ID is set during handleRequest)
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) delete httpTransports[sid];
    };

    await transport.handleRequest(req, res, {
      onSessionInitialized: (sid) => {
        httpTransports[sid] = transport;
      },
    });
  } else {
    res.status(400).json({ error: "No active session. Send a POST request first." });
  }
}

// Listen on BOTH root "/" and "/mcp"
app.post("/", handleStreamableHTTP);
app.get("/", handleStreamableHTTP);
app.delete("/", handleStreamableHTTP);
app.post("/mcp", handleStreamableHTTP);
app.get("/mcp", handleStreamableHTTP);
app.delete("/mcp", handleStreamableHTTP);

// ─── SSE Transport (fallback) ───
const sseTransports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  sseTransports[transport.sessionId] = transport;

  transport.onclose = () => {
    delete sseTransports[transport.sessionId];
  };

  await server.connect(transport);
  await transport.start();
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: "Unknown session ID" });
  }
});

// ─── Health check ───
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "pricing-risk-data",
    tools: ["get_fx_rates", "get_inflation_data", "get_commodity_prices"],
    transports: ["streamable-http (/ and /mcp)", "sse (/sse)"],
  });
});

// ─── Start ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pricing Risk MCP Server running on port ${PORT}`);
  console.log(`Streamable HTTP: POST / or POST /mcp`);
  console.log(`SSE: GET /sse`);
  console.log(`Health: GET /health`);
});
