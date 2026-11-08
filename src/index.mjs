#!/usr/bin/env node
/**
 * WeatherXM FACT — Model Context Protocol (MCP) Server (stdio & Streamable HTTP)
 *
 * Exposes the 4 read-only WeatherXM FACT forecast verification tools locally over
 * stdio (for Claude Desktop, Cursor, Glama Docker introspection, and CLI agents)
 * while delegating benchmark queries to the public edge endpoint at
 * https://fact.weatherxm.com/mcp (or FACT_MCP_ENDPOINT).
 */
import readline from 'node:readline';

const ENDPOINT = process.env.FACT_MCP_ENDPOINT || 'https://fact.weatherxm.com/mcp';
const DEFAULT_VERSION = '2025-03-26';
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

export const MCP_TOOLS = [
  {
    "name": "get_best_forecast_model",
    "description": "Find which weather forecast model had the lowest verified historical error (MAE) for a latitude/longitude coordinate (or station_or_report_id), weather variable (temperature, wind_speed, wind_direction, precipitation, humidity), and forecast horizon (Days 0-7). For wind_direction, errors are circular shortest-arc angular errors (0°–180°, where 359° vs 1° = 2° error) on hourly unit-vector averages, returning both all-hours and >3 m/s active-wind rankings. All 45 FACT models: WeatherXM MOSAIC (MOSAIC), meteoblue (METEOBLUE), meteoblue station-mLM (mLM), ECMWF IFS (IFS025, IFSHRES), ECMWF AIFS AI (AIFS025), NOAA GFS (GFS05, GFS025), NOAA HRRR (HRRR), NOAA National Blend of Models (NBM), NOAA NAM (NAM3, NAM5, NAM12, NAMAK), DWD ICON (ICON, ICONEU, ICOND2), UK Met Office (UMGLOBAL10, UKMO2), ECCC GEM (GEM15, GEM2), Meteo-France ARPEGE/AROME (MFGLOBAL, MFEU, MFFR), COSMO (COSMOI2, COSMOM5), HARMONIE-AROME (HARMONIE), JMA MSM (MSM), WRF (WRFGR, WRFAMS), meteoblue NEMS/NMM (NEMSGLOBAL, NEMSGLOBAL_E, NEMS4, NEMS12, NEMS12_E, NEMSAF01, NEMSAS02, NEMSCAM, NEMSIN, NEMSNZ, NEMSSA, NMM4, NMM22), and regional models (AF01, AS01, SA01). Useful for solar & wind energy forecasting, agriculture & frost/irrigation risk, maritime/port & drone operations, construction planning, and microclimate evaluation. Provide (lat, lon) or station_or_report_id. Missing results stay unknown; not live forecasting.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "title": "Get Best Weather Forecast Model"
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
        },
        "lon": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "variable": {
          "type": "string",
          "enum": [
            "temperature",
            "wind_speed",
            "wind_direction",
            "precipitation",
            "humidity"
          ],
          "default": "temperature"
        },
        "lead_day": {
          "type": "string",
          "enum": [
            "all",
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7"
          ]
        },
        "exclude_commissioned": {
          "type": "boolean",
          "default": false
        },
        "station_or_report_id": {
          "type": "string",
          "maxLength": 80,
          "description": "Optional WeatherXM station UUID or custom site evaluation report ID (e.g. STUDY-...)"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "check_ground_truth_coverage",
    "description": "Check historical WeatherXM FACT ground-station publication coverage for any coordinate (H3 Res-7 cell, ~5.2 km²) or station_or_report_id across temperature, wind_speed, wind_direction, precipitation, and humidity, plus nearest evaluated reference cell distance and interactive map citation link. Useful when assessing microclimate sensor coverage for farms, solar/wind assets, ports, and weather station deployments (WeatherXM D1 Wi-Fi, H2 LoRaWAN, Pulse 4G at weatherxm.com/stations). Provide (lat, lon) or station_or_report_id. Does not establish current live station presence or absence.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "title": "Check Ground-Truth Station Coverage"
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
        },
        "lon": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "variable": {
          "type": "string",
          "enum": [
            "temperature",
            "wind_speed",
            "wind_direction",
            "precipitation",
            "humidity"
          ],
          "default": "temperature"
        },
        "lead_day": {
          "type": "string",
          "enum": [
            "all",
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7"
          ]
        },
        "exclude_commissioned": {
          "type": "boolean",
          "default": false
        },
        "station_or_report_id": {
          "type": "string",
          "maxLength": 80,
          "description": "Optional WeatherXM station UUID or custom site evaluation report ID (e.g. STUDY-...)"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_fact_leaderboard",
    "description": "Read the global weather forecast accuracy leaderboard (MAE, RMSE, circular angular error for wind_direction including >3 m/s active-wind curves, and categorical rain skill HSS, POD, FAR, CSI across lead days 0..7) or country-level published H3 cell-win summaries across all 45 forecast models and 8,927 stations. All 45 FACT models: WeatherXM MOSAIC (MOSAIC), meteoblue (METEOBLUE), meteoblue station-mLM (mLM), ECMWF IFS (IFS025, IFSHRES), ECMWF AIFS AI (AIFS025), NOAA GFS (GFS05, GFS025), NOAA HRRR (HRRR), NOAA National Blend of Models (NBM), NOAA NAM (NAM3, NAM5, NAM12, NAMAK), DWD ICON (ICON, ICONEU, ICOND2), UK Met Office (UMGLOBAL10, UKMO2), ECCC GEM (GEM15, GEM2), Meteo-France ARPEGE/AROME (MFGLOBAL, MFEU, MFFR), COSMO (COSMOI2, COSMOM5), HARMONIE-AROME (HARMONIE), JMA MSM (MSM), WRF (WRFGR, WRFAMS), meteoblue NEMS/NMM (NEMSGLOBAL, NEMSGLOBAL_E, NEMS4, NEMS12, NEMS12_E, NEMSAF01, NEMSAS02, NEMSCAM, NEMSIN, NEMSNZ, NEMSSA, NMM4, NMM22), and regional models (AF01, AS01, SA01). Country counts describe published cell wins, not national matched-sample accuracy.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "title": "Get Forecast Accuracy Leaderboard"
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "variable": {
          "type": "string",
          "enum": [
            "temperature",
            "wind_speed",
            "wind_direction",
            "precipitation",
            "humidity"
          ],
          "default": "temperature"
        },
        "lead_day": {
          "type": "string",
          "enum": [
            "all",
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7"
          ]
        },
        "exclude_commissioned": {
          "type": "boolean",
          "default": false
        },
        "country": {
          "type": "string",
          "maxLength": 80
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 45,
          "default": 45,
          "description": "Maximum number of ranked models to return (1..45, default 45 for full model universe)."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_model_head_to_head",
    "description": "Compare up to 10 weather forecast models head-to-head across lead days 0 to 7 on global historical error curves (including circular angular error and >3 m/s active-wind curves for wind_direction), plus optional local H3 cell (lat/lon) matched-cohort or country cell-win comparisons, with explicit cohort and station-commissioned (mLM) caveats. All 45 FACT models: WeatherXM MOSAIC (MOSAIC), meteoblue (METEOBLUE), meteoblue station-mLM (mLM), ECMWF IFS (IFS025, IFSHRES), ECMWF AIFS AI (AIFS025), NOAA GFS (GFS05, GFS025), NOAA HRRR (HRRR), NOAA National Blend of Models (NBM), NOAA NAM (NAM3, NAM5, NAM12, NAMAK), DWD ICON (ICON, ICONEU, ICOND2), UK Met Office (UMGLOBAL10, UKMO2), ECCC GEM (GEM15, GEM2), Meteo-France ARPEGE/AROME (MFGLOBAL, MFEU, MFFR), COSMO (COSMOI2, COSMOM5), HARMONIE-AROME (HARMONIE), JMA MSM (MSM), WRF (WRFGR, WRFAMS), meteoblue NEMS/NMM (NEMSGLOBAL, NEMSGLOBAL_E, NEMS4, NEMS12, NEMS12_E, NEMSAF01, NEMSAS02, NEMSCAM, NEMSIN, NEMSNZ, NEMSSA, NMM4, NMM22), and regional models (AF01, AS01, SA01).",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "title": "Compare Forecast Models Head-to-Head"
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "lat": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
        },
        "lon": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "variable": {
          "type": "string",
          "enum": [
            "temperature",
            "wind_speed",
            "wind_direction",
            "precipitation",
            "humidity"
          ],
          "default": "temperature"
        },
        "lead_day": {
          "type": "string",
          "enum": [
            "all",
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7"
          ]
        },
        "exclude_commissioned": {
          "type": "boolean",
          "default": false
        },
        "country": {
          "type": "string",
          "maxLength": 80
        },
        "models": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 40
          },
          "minItems": 1,
          "maxItems": 10
        }
      },
      "additionalProperties": false
    }
  }
];

async function forwardToolCall(id, params) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'weatherxm-fact-mcp-stdio/2.1.0'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params })
    });
    return await res.json();
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'FACT remote endpoint unreachable: ' + (err?.message || String(err)) }],
        isError: true
      }
    };
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (!('id' in msg)) {
    return null; // Notification
  }
  const id = msg.id;
  const params = msg.params ?? {};

  if (msg.method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' && SUPPORTED_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : DEFAULT_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'weatherxm-fact-mcp', version: '2.1.0' },
        instructions: 'Historical FACT archive only. Preserve provenance, missing-result and cohort caveats. Do not interpret publication gaps as no stations or historical MAE as a guarantee.'
      }
    };
  }
  if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  if (msg.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (msg.method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (msg.method === 'tools/call') return await forwardToolCall(id, params);

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const replies = [];
      for (const item of parsed) {
        const r = await handleMessage(item);
        if (r !== null) replies.push(r);
      }
      if (replies.length > 0) process.stdout.write(JSON.stringify(replies) + '\n');
    } else {
      const reply = await handleMessage(parsed);
      if (reply !== null) process.stdout.write(JSON.stringify(reply) + '\n');
    }
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
  }
});
