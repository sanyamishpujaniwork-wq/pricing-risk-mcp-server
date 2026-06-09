/**
 * Pricing Risk MCP Server
 * 
 * A Model Context Protocol (MCP) server that wraps free financial APIs
 * and exposes them as tools that GEP QI can call directly.
 * 
 * APIs used (all free, no keys required):
 *   - Frankfurter (ECB data) — live FX exchange rates
 *   - World Bank — country CPI inflation
 *   - World Bank — commodity price indices
 *   
 * Run: npm start
 * QI connects to: http://<your-host>:3000/mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
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
// Create the MCP Server
// ─────────────────────────────────────────────────
const server = new McpServer({
  name: "pricing-risk-data",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════════
// TOOL 1: get_fx_rates
// Source: Frankfurter API (European Central Bank data)
// ═══════════════════════════════════════════════════
server.tool(
  "get_fx_rates",
  "Get live foreign exchange rates from the European Central Bank. Returns current USD conversion rates for specified currencies. Use to assess currency exposure risk.",
  {
    currencies: z
      .string()
      .default("INR,EUR,CNY,GBP")
      .describe("Comma-separated target currencies (e.g. 'INR,EUR,CNY,GBP')"),
  },
  async ({ currencies }) => {
    try {
      const data = await fetchJSON(
        `https://api.frankfurter.app/latest?from=USD&to=${currencies}`
      );
      
      // Also fetch 12-month-ago rates for volatility calculation
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const dateStr = oneYearAgo.toISOString().split("T")[0];
      
      const historicalData = await fetchJSON(
        `https://api.frankfurter.app/${dateStr}?from=USD&to=${currencies}`
      );

      // Calculate 12-month change for each currency
      const changes = {};
      for (const [currency, currentRate] of Object.entries(data.rates)) {
        const oldRate = historicalData.rates[currency];
        if (oldRate) {
          const changePct = ((currentRate - oldRate) / oldRate * 100).toFixed(2);
          changes[currency] = {
            current_rate: currentRate,
            rate_12_months_ago: oldRate,
            change_percent: parseFloat(changePct),
            direction: changePct > 0 ? "USD strengthened (supplier currency weakened)" : "USD weakened (supplier currency strengthened)",
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "European Central Bank via Frankfurter API",
              base_currency: "USD",
              current_date: data.date,
              historical_date: historicalData.date,
              current_rates: data.rates,
              twelve_month_changes: changes,
              interpretation: "A positive change_percent means USD got stronger (good for USD buyers). A negative change means the supplier's currency got stronger (bad — their costs in USD terms went up).",
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching FX rates: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════
// TOOL 2: get_inflation_data
// Source: World Bank Open Data API
// ═══════════════════════════════════════════════════
server.tool(
  "get_inflation_data",
  "Get official CPI inflation rate for a country from the World Bank. Returns annual inflation percentages for recent years. Use to assess macro risk and whether supplier cost pressures are rising.",
  {
    country_code: z
      .string()
      .describe("ISO 3-letter country code: USA, IND (India), DEU (Germany), CHN (China), GBR (UK), IRL (Ireland), SGP (Singapore), PHL (Philippines)"),
  },
  async ({ country_code }) => {
    try {
      // CPI inflation (annual %)
      const cpiUrl = `https://api.worldbank.org/v2/country/${country_code}/indicator/FP.CPI.TOTL.ZG?format=json&date=2020:2026&per_page=10`;
      const cpiRaw = await fetchJSON(cpiUrl);

      // GDP growth for context
      const gdpUrl = `https://api.worldbank.org/v2/country/${country_code}/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=2020:2026&per_page=10`;
      const gdpRaw = await fetchJSON(gdpUrl);

      // Parse CPI data
      const cpiData = (cpiRaw[1] || [])
        .filter((d) => d.value !== null)
        .map((d) => ({ year: d.date, cpi_percent: parseFloat(d.value.toFixed(2)) }))
        .sort((a, b) => b.year - a.year);

      // Parse GDP data
      const gdpData = (gdpRaw[1] || [])
        .filter((d) => d.value !== null)
        .map((d) => ({ year: d.date, gdp_growth_percent: parseFloat(d.value.toFixed(2)) }))
        .sort((a, b) => b.year - a.year);

      const countryName = cpiRaw[1]?.[0]?.country?.value || country_code;
      const latestCpi = cpiData[0];
      const previousCpi = cpiData[1];

      // Determine risk level
      let inflationRisk = "LOW";
      if (latestCpi && latestCpi.cpi_percent > 10) inflationRisk = "CRITICAL";
      else if (latestCpi && latestCpi.cpi_percent > 6) inflationRisk = "HIGH";
      else if (latestCpi && latestCpi.cpi_percent > 3) inflationRisk = "MODERATE";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "World Bank Open Data",
              country: countryName,
              country_code: country_code,
              latest_cpi: latestCpi || "No data available",
              previous_cpi: previousCpi || "No data available",
              cpi_trend: cpiData.slice(0, 5),
              gdp_trend: gdpData.slice(0, 5),
              inflation_risk_level: inflationRisk,
              interpretation: `${countryName} CPI inflation is ${latestCpi?.cpi_percent ?? 'N/A'}% (${inflationRisk} risk). If the supplier's contract escalation cap is below this, the supplier is losing real margin and may push for renegotiation.`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching inflation data: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════
// TOOL 3: get_commodity_prices
// Source: World Bank Commodity Markets
// ═══════════════════════════════════════════════════
server.tool(
  "get_commodity_prices",
  "Get global commodity price indices from the World Bank. Returns index values (2010=100) for metals, energy, and agriculture. Use to assess raw material cost volatility for hardware and manufacturing suppliers.",
  {
    commodity_group: z
      .enum(["metals", "energy", "all"])
      .default("all")
      .describe("Which commodity group to query: 'metals' (for hardware/manufacturing), 'energy' (for logistics/operations), or 'all'"),
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
          indicator_code: ind.code,
          latest: latest || "No data",
          previous: previous || "No data",
          year_over_year_change_percent: yoyChange,
          trend: dataPoints.slice(0, 5),
          direction: yoyChange > 0 ? "RISING" : yoyChange < 0 ? "FALLING" : "STABLE",
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "World Bank Commodity Markets (Pink Sheet)",
              base_index: "2010 = 100",
              commodities: results,
              interpretation: "Rising commodity indices mean higher raw material costs for hardware suppliers. Compare the year-over-year change against the supplier's contract escalation cap to assess whether the cap provides adequate protection.",
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching commodity prices: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────────
// Start the HTTP server
// ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Store transports by session
const transports = {};

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] || "default";
    
    let transport = transports[sessionId];
    if (!transport) {
      transport = new StreamableHTTPServerTransport("/mcp");
      transports[sessionId] = transport;
      await server.connect(transport);
    }
    
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Handle GET for SSE (some MCP clients use this)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] || "default";
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No active session. Send a POST first." });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", tools: ["get_fx_rates", "get_inflation_data", "get_commodity_prices"] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Pricing Risk MCP Server running on port ${PORT}`);
  console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`\n   Tools available:`);
  console.log(`   • get_fx_rates        — Live FX rates from ECB`);
  console.log(`   • get_inflation_data   — Country CPI from World Bank`);
  console.log(`   • get_commodity_prices — Commodity indices from World Bank`);
  console.log(`\n   Connect this URL in GEP QI → MCP tab: http://<your-host>:${PORT}/mcp\n`);
});
