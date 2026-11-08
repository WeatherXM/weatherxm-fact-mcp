#!/usr/bin/env python3
"""
Query the live WeatherXM FACT MCP Server (https://fact.weatherxm.com/mcp) via JSON-RPC 2.0.
No API key or authentication required.
"""
import json
import urllib.request

MCP_URL = "https://fact.weatherxm.com/mcp"


def call_fact_mcp(tool_name: str, arguments: dict) -> dict:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    req = urllib.request.Request(
        MCP_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "weatherxm-fact-example/2.1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        rpc_response = json.loads(resp.read().decode("utf-8"))
        return rpc_response["result"]["structuredContent"]


if __name__ == "__main__":
    # 1. Best forecast model for Athens (37.9838, 23.7278), Day-1 Temperature
    athens = call_fact_mcp(
        "get_best_forecast_model",
        {"lat": 37.9838, "lon": 23.7278, "variable": "temperature", "lead_day": "1", "exclude_commissioned": True},
    )
    print("Athens Day-1 non-commissioned champion:", athens["cell_verification_result"]["champion_model"])

    # 2. Head-to-head comparison (Global + Greece cell wins + Athens local cell)
    h2h = call_fact_mcp(
        "get_model_head_to_head",
        {
            "variable": "wind_speed",
            "models": ["MOSAIC", "METEOBLUE", "IFS025", "GFS05", "ICON"],
            "country": "GR",
            "lead_day": "1",
        },
    )
    print("Greece Day-1 wind speed cell wins:", h2h["country_comparison"]["requested_models_cell_wins"])
