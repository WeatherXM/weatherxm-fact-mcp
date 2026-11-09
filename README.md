# WeatherXM FACT — Forecast Accuracy Tracking (Methodology, Verification Pipeline & MCP Server)

[![Website](https://img.shields.io/badge/Interactive_Map-fact.weatherxm.com-0284c7)](https://fact.weatherxm.com)
[![MCP Endpoint](https://img.shields.io/badge/Streamable_HTTP_MCP-fact.weatherxm.com%2Fmcp-10b981)](https://fact.weatherxm.com/mcp)
[![WeatherXM FACT MCP Connector](https://glama.ai/mcp/connectors/com.weatherxm.fact/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.weatherxm.fact/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**WeatherXM FACT (Forecast Accuracy Tracking)** is an empirical, station-based weather forecast verification benchmark scoring **45 numerical weather prediction (NWP), AI foundation, regional, and post-processed forecast models** against **8,927 quality-controlled physical WeatherXM ground stations** (**1.83 billion+ hourly forecast–observation evaluation records** across the 2025 archive).

This repository serves three purposes:
1. **Scientific & Engineering Transparency (`docs/`, `pipeline/`, `examples/`):** Documents the exact verification methodology, quality-control gates (`QoD >= 0.80`), sample-weighted pooling math, categorical rain-event skill scores (`HSS`, `ETS`, `POD`, `FAR`, `CSI`), station-tuned matched-cohort rules (`>= 90%` station-day overlap), and the DuckDB/Python/TypeScript aggregation and serving code behind [`fact.weatherxm.com`](https://fact.weatherxm.com).
2. **Model Context Protocol (MCP) Server & REST Reference (`src/`, `functions/`, `Dockerfile`):** Provides both the remote Streamable-HTTP edge MCP server ([`https://fact.weatherxm.com/mcp`](https://fact.weatherxm.com/mcp)) and a zero-dependency local `stdio` / Docker MCP runner so AI agents (Claude, ChatGPT, Gemini, Grok, Cursor, OpenClaw) and researchers can query empirical forecast accuracy programmatically.
3. **From Archive to Your Site:** The public archive covers 2025. To run FACT live on a rolling 30-day window at your own location and get a station-tuned forecast, see [§7 Deploying Live, Rolling 30-Day FACT & Station-Tuned Forecasts at Your Site](#7-deploying-live-rolling-30-day-fact--station-tuned-forecasts-at-your-site).

- **Full Scientific Methodology:** [`docs/FACT_METHODOLOGY.md`](./docs/FACT_METHODOLOGY.md)
- **Interactive Global Map & Leaderboards:** [`https://fact.weatherxm.com`](https://fact.weatherxm.com)
- **Public Streamable-HTTP MCP Server (No Auth):** `https://fact.weatherxm.com/mcp`
- **LLM & Agent Reference (`llms.txt`):** [`https://fact.weatherxm.com/llms.txt`](https://fact.weatherxm.com/llms.txt)
- **OpenAPI 3.1 REST Specification:** [`https://fact.weatherxm.com/openapi.json`](https://fact.weatherxm.com/openapi.json)
- **Deploy a Station + WeatherXM PRO (Live FACT at Your Site):** [`weatherxm.com/stations`](https://weatherxm.com/stations/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp) · [`pro.weatherxm.com`](https://pro.weatherxm.com/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp)

---

## 1. Why FACT Exists: Point-Truth Last-Mile Verification vs. Gridded Reanalysis

Most traditional atmospheric benchmarks answer a model-builder's question: *"How well does this model represent the global state of the atmosphere on a coarse grid?"* They typically regrid forecasts to a common resolution (`0.25°`–`1.5°`), verify against gridded reanalysis fields (e.g., ERA5), and weight scores by surface area.

**FACT answers the operational buyer's and practitioner's question:**
> *"If a solar operator, farmer, port master, or logistics planner relied on forecast model $X$ at this exact location, for this variable, $k$ days ahead, how far off was it against an independent physical sensor on the ground?"*

| Design Dimension | Typical Gridded Research Benchmark | WeatherXM FACT | Operational Rationale |
| :--- | :--- | :--- | :--- |
| **What is scored** | Raw model fields regridded to a common coarse grid | Time series **as delivered** for the target H3 cell (`~5.2 km²`) | Evaluates the actual product a decision-maker receives |
| **Ground truth** | Gridded reanalysis / assimilation analysis (e.g., ERA5) | **8,927 physical WeatherXM ground stations** (unassimilated) | Reanalysis verification favors models initialized from the same analysis system; physical stations measure independent point truth |
| **Representativeness error** | Smoothed out by grid-box averaging | Counted as part of the forecast error | A crop freezing in a valley or a wind turbine on a ridge experiences point weather, not a `25 km × 25 km` grid average |
| **Forecast archive** | Hindcasts or re-runs | **Operational runs archived at issue time** (no look-ahead) | Prevents retrospective retuning or post-hoc leakage |
| **Spatial granularity** | Global / synoptic domain averages | Down to **Uber H3 Resolution 7 cells (`~5.2 km²`)** and individual stations | *"Best on global average"* is frequently **not** *"best at your site"* |

---

## 2. Verification Methodology & Mathematical Formulation

The complete 10-section specification is in [`docs/FACT_METHODOLOGY.md`](./docs/FACT_METHODOLOGY.md). Below is the core mathematical pipeline with reference code from [`examples/verification_formulas.py`](./examples/verification_formulas.py) and [`pipeline/`](./pipeline/).

### 2.1 Observation Construction & Hourly UTC Pairing

Raw sub-hourly station telemetry is aggregated in UTC to match what each forecast variable represents physically:

| Variable | Hourly Observation Construction | Verified Against | Gross-Error Screen (`max_mae`) |
| :--- | :--- | :--- | :--- |
| **Temperature (`temperature`, `°C`)** | 1-minute mean nearest the top of the hour (`±10 min` window) | 2 m air temperature at valid hour | `40.0 °C` |
| **Relative Humidity (`humidity`, `%`)** | 1-minute mean nearest the top of the hour (`±10 min` window) | 2 m relative humidity at valid hour | `100.0 %` |
| **Wind Speed (`wind_speed`, `m/s`)** | Magnitude of the hour's vector-averaged u/v, multiplied by a fixed `1.35135` (pipeline comment: 2 m → 10 m, source meteoblue) for every station regardless of actual mast height. Default rankings use all hours; an optional, separate *windier days* subset keeps station-days with scaled daily-mean observed speed `>= 3.0 m/s` (conditioned subset, not a height correction; see methodology §3.2a) | 10 m wind speed at valid hour | `30.0 m/s` |
| **Wind Direction (`wind_direction`, `°`)** | Speed-weighted vector average of the hour; error is the shortest-arc circular difference in `[0°, 180°]` (`359°` vs `1°` = `2°`). Rankings are published for all hours and for an active-wind subset (raw sensor speed `> 3 m/s`) | 10 m wind direction at valid hour | `180.0 °` |
| **Precipitation (`precipitation`, `mm`)** | Hourly/daily difference of cumulative rain counter (negative resets clamped to `0`) | Hourly & 24-hour UTC accumulated precipitation | `50.0 mm` |

**Lead-day definition:** Lead time is measured from **when the model run started (`initialization_date` in UTC)**—never from when the forecast was fetched—so all 45 models are evaluated on a single, fair synoptic clock:

$$\text{lead\_day} = \text{datediff}\left(\text{'day'},\ \text{ initialization\_date}_{\text{UTC}},\ \text{target\_date}_{\text{UTC}}\right) \in \{0, 1, 2, 3, 4, 5, 6, 7\}$$

---

### 2.2 Three-Stage Quality of Data (`QoD`) Gate

Community-hosted weather stations require strict automated screening before any verification metric is computed. A station-day record $(s, m, r, v, d)$ is admitted into FACT **if and only if** it passes all three gates:

1. **Daily WeatherXM `QoD >= 0.80` ([Quality of Data](https://docs.weatherxm.com/weather-and-science/quality-mechanisms)):**
   - **Out-of-Bounds Check (OBC):** Rejects readings outside physical sensor hardware limits.
   - **Self Quality Check (SQC):** Flags stuck sensors (constancy > 4–6h), unphysical minute-to-minute spikes (`> 2 °C` raw or `> 3 °C` minute jump),frozen anemometers at sub-zero temperatures, and packet dropouts.
   - **Indoors Station Detector (ISD):** Rolling 7-day solar clear-sky irradiance envelope + thermal/wind damping check to reject indoor, balcony, or tilted deployments.
   - **Station Photo Verification (SPV):** Four-direction installation audit against WMO obstacle-distance rules.
2. **Minimum Hourly Completeness (`n >= 18` of `24` hours):** At least 75% of the UTC day must have valid paired forecast and observation values.
3. **Physical Plausibility Screen:** Rejects broken records where `daily_MAE` exceeds the gross-error ceiling (`40 °C`, `30 m/s`, `180°`, `50 mm`, `100%`).

---

### 2.3 Continuous Error Scoring & Sample-Weighted Pooling (`1.83B+` Records)

For a single station $s$, model $m$, initialization run $r$, variable $v$, and UTC target day $d$ with $n \in [18, 24]$ valid hourly pairs $(f_h, o_h)$:

$$\text{MAE}_{s,m,r,d} = \frac{1}{n} \sum_{h=1}^{n} |f_h - o_h|, \qquad \text{RMSE}_{s,m,r,d} = \sqrt{\frac{1}{n} \sum_{h=1}^{n} (f_h - o_h)^2}$$

When pooling across $K$ station-days (e.g., an H3 cell, a country, or a global lead-day curve), **FACT never takes an unweighted average of daily errors or a linear average of daily RMSEs** (which mathematically understates large errors). Every pooled metric weights by the exact hourly pair count $n_i$, and RMSE is pooled through mean squared error:

$$\text{Pooled MAE} = \frac{\sum_{i=1}^{K} n_i \cdot \text{MAE}_i}{\sum_{i=1}^{K} n_i}, \qquad \text{Pooled RMSE} = \sqrt{\frac{\sum_{i=1}^{K} n_i \cdot \text{RMSE}_i^2}{\sum_{i=1}^{K} n_i}}$$

For `wind_direction`, $|f_h - o_h|$ is replaced by the circular shortest-arc distance $\min(|f_h - o_h|,\ 360^\circ - |f_h - o_h|)$; pooling is identical.

#### Reference Implementation (DuckDB SQL & Python — from [`pipeline/bake_fact_summary.py`](./pipeline/bake_fact_summary.py))

```sql
-- Illustrative DuckDB aggregation for global lead-day curves. The QoD >= 0.80 station-day gate is
-- applied by joining the daily QoD table on (target date, device). The production bakers apply it via
-- a QoD table that contains only station-days with qod_score >= 0.80; it is written explicitly here.
SELECT
    e.model,
    datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) AS lead_day,
    count(*) AS evaluated_records,   -- device x model x run x target date (published as "samples")
    round(sum(e.daily_MAE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE), 3) AS pooled_mae,
    round(sqrt(sum(e.daily_RMSE * e.daily_RMSE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE)), 3) AS pooled_rmse,
    sum(e.n_samples_MAE_RMSE) AS total_hourly_pairs
FROM read_parquet('data/2025_full/*/*.parquet', hive_partitioning = true) e   -- partition `date` = target date
JOIN read_parquet('data/qod_daily/*.parquet') q
  ON q.date = cast(e.date AS VARCHAR) AND q.device_id = e.device_id AND q.qod_score >= 0.80
WHERE e.variable = 'temperature'
  AND e.daily_MAE BETWEEN 0 AND 40.0
  AND e.n_samples_MAE_RMSE >= 18
  AND datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) BETWEEN 0 AND 7
GROUP BY ALL
HAVING count(*) > 50
ORDER BY lead_day ASC, pooled_mae ASC;
```

---

### 2.4 Categorical Rain-Event Verification (`HSS`, `ETS`, `POD`, `FAR`, `CSI`) & Station Bootstrap

Millimeter precipitation MAE is heavily distorted by dry days: a model that forecasts `"0 mm"` every day achieves a deceptively low millimeter MAE in dry climates while missing 100% of rain events.

To evaluate operational rain-detection skill, FACT classifies each UTC station-day using a **`>= 0.25 mm/day` wet-day threshold** into a $2 \times 2$ contingency table:
- $a$ (**Hits**): Forecast $\ge 0.25\text{ mm}$ and Observed $\ge 0.25\text{ mm}$
- $b$ (**False Alarms**): Forecast $\ge 0.25\text{ mm}$ and Observed $< 0.25\text{ mm}$
- $c$ (**Misses**): Forecast $< 0.25\text{ mm}$ and Observed $\ge 0.25\text{ mm}$
- $d$ (**Correct Negatives**): Forecast $< 0.25\text{ mm}$ and Observed $< 0.25\text{ mm}$

Counts $(a, b, c, d)$ are **summed across all station-days first** (daily skill scores are never averaged), yielding:

$$\text{HSS} = \frac{2(ad - bc)}{(a+c)(c+d) + (a+b)(b+d)}, \qquad \text{POD} = \frac{a}{a+c}, \qquad \text{FAR} = \frac{b}{a+b}, \qquad \text{CSI} = \frac{a}{a+b+c}$$

#### Reference Implementation (from [`pipeline/bake_precip_skill.py`](./pipeline/bake_precip_skill.py))

```python
import numpy as np

def contingency_scores(a, b, c, d):
    """Scores from summed contingency counts: a hits, b false alarms, c misses, d correct negatives."""
    a, b, c, d = (np.asarray(x, dtype=float) for x in (a, b, c, d))
    n = a + b + c + d
    with np.errstate(divide='ignore', invalid='ignore'):
        hss = 2 * (a * d - b * c) / ((a + c) * (c + d) + (a + b) * (b + d))
        a_random = (a + b) * (a + c) / n
        ets = (a - a_random) / (a + b + c - a_random)
        return {
            'hss': hss,          # Heidke Skill Score (1 = perfect, 0 = random chance)
            'ets': ets,          # Equitable Threat Score (Gilbert Skill Score)
            'pod': a / (a + c),  # Probability of Detection (Hit Rate)
            'far': b / (a + b),  # False Alarm Ratio
            'csi': a / (a + b + c),  # Critical Success Index (Threat Score)
            'fbi': (a + b) / (a + c),  # Frequency Bias Index (>1 wet bias, <1 dry bias)
            'base_rate': (a + c) / n,
        }

def bootstrap_hss(station_counts, n_boot=400, rng=None, level=0.90):
    """Station-level Poisson block bootstrap for 90% HSS confidence intervals.
    Resamples whole stations (shape: [n_stations, 4]) to preserve intra-station temporal correlation."""
    rng = rng or np.random.default_rng(42)
    weights = rng.poisson(1.0, size=(n_boot, len(station_counts)))
    totals = weights @ station_counts  # (n_boot, 4) -> summed [a, b, c, d] per bootstrap draw
    hss = contingency_scores(totals[:, 0], totals[:, 1], totals[:, 2], totals[:, 3])['hss']
    hss = hss[np.isfinite(hss)]
    tail = (1 - level) / 2 * 100
    return float(np.percentile(hss, tail)), float(np.percentile(hss, 100 - tail))
```

---

### 2.5 Station-Tuned Forecasts vs. Standalone Global NWP (Matched-Cohort Scoring)

FACT scores two kinds of forecast side by side:

- **Standalone NWP and AI models** (`IFS025`, `GFS05`, `ICON`, `AIFS025`, `HRRR`, …): one model's physics or learned dynamics, delivered for a grid point.
- **Station-tuned forecasts** (**WeatherXM MOSAIC** and **meteoblue mLM**): blends that combine 30–45 underlying models and continuously re-weight and calibrate them against local ground-station truth over a rolling window. Instead of trusting one model everywhere, they learn which models perform best at a specific site, for each variable and lead time, and correct their local biases.

This is the core finding FACT exists to measure: the best global model is often not the best model at your site, and local truth closes that gap. Background: [The Case for Local Truth: Why MOSAIC Matters](https://blog.weatherxm.com/the-case-for-local-truth-why-mosaic-matters-6543499b8c44) and [meteoblue Learning MultiModel (mLM)](https://content.meteoblue.com/en/research-education/specifications/data-sources/post-processing/meteoblue-learning-multimodel-mlm).

Because station-tuned forecasts run where a station is tuned in, FACT scores them on equal footing:

1. **`>= 90%` Matched Cohort (`commissioned_evaluation.matched_cohort_top_models`):** In any H3 cell where a station-tuned forecast is active, every competing model is scored on the exact same `(device_id, target_date)` pairs. Models covering `< 90%` of those station-days are listed in `excluded_low_overlap` rather than ranked (`pipeline/enrich_cells_top5.py`).
2. **`exclude_commissioned` Toggle:** Every tool accepts `exclude_commissioned: true` to return a standalone-model ranking only (`top_non_commissioned_models`) — useful when you want to pick the best raw model to feed your own pipeline.

---

## 3. The 45 Evaluated Forecast Models

| Category | Model IDs in FACT MCP / API | Provider / Modeling Center |
| :--- | :--- | :--- |
| **Global NWP** | `IFS025`, `IFSHRES`, `GFS05` (alias `GFS025`/`GFS`), `ICON`, `UMGLOBAL10` (alias `UKMO`), `GEM15` (alias `GEM`), `MFGLOBAL` (alias `ARPEGE`) | ECMWF, NOAA NCEP, DWD, UK Met Office, ECCC, Météo-France |
| **AI Foundation Models** | `AIFS025` (alias `AIFS`) | ECMWF Artificial Intelligence Forecasting System |
| **Station-Tuned & Multi-Model Blends** | `MOSAIC` (station-tuned), `mLM` (station-tuned), `METEOBLUE`, `NBM` | WeatherXM MOSAIC, meteoblue, NOAA National Blend of Models |
| **European High-Res LAMs** | `ICONEU`, `ICOND2`, `MFEU`, `MFFR` (alias `AROME`), `UKMO2`, `COSMOI2`, `COSMOM5`, `HARMONIE`, `WRFGR` | DWD, Météo-France, UKMO, COSMO, HIRLAM/HARMONIE, WRF |
| **North American & Global LAMs** | `HRRR`, `NAM3`, `NAM5`, `NAM12`, `NAMAK`, `GEM2`, `MSM`, `WRFAMS` | NOAA NCEP, ECCC, Japan Meteorological Agency (JMA), WRF |
| **meteoblue NEMS / NMM & Regional** | `NEMSGLOBAL`, `NEMSGLOBAL_E`, `NEMS4`, `NEMS12`, `NEMS12_E`, `NEMSAF01`, `NEMSAS02`, `NEMSCAM`, `NEMSIN`, `NEMSNZ`, `NEMSSA`, `NMM4`, `NMM22`, `AF01`, `AS01`, `SA01` | meteoblue NEMS / NMM regional & global suites |

---

## 4. Connecting Your AI Agent (MCP & REST)

### Option A: Remote Streamable-HTTP MCP Server (Recommended — Zero Install, No Auth)

Point any MCP-compatible client directly to **`https://fact.weatherxm.com/mcp`**:

- **Claude Code CLI:**
  ```bash
  claude mcp add --transport http weatherxm-fact https://fact.weatherxm.com/mcp
  ```
- **Cursor / Windsurf / VS Code / Claude Desktop (`mcp.json`):**
  ```json
  {
    "mcpServers": {
      "weatherxm-fact": {
        "url": "https://fact.weatherxm.com/mcp"
      }
    }
  }
  ```

### Option B: Local `stdio` or Docker MCP Server (This Repository)

```bash
# Run directly with Node.js (>= 18)
git clone https://github.com/WeatherXM/weatherxm-fact-mcp.git
cd weatherxm-fact-mcp
npm test
node src/index.mjs
```

Or via Docker:
```bash
docker build -t weatherxm-fact-mcp .
docker run -i --rm weatherxm-fact-mcp
```

---

## 5. Exposed MCP Tools & REST Endpoints

| MCP Tool Name | REST GET Mirror | Description & Key Parameters |
| :--- | :--- | :--- |
| **`get_best_forecast_model`** | `/api/v1/fact/best-model` | Returns the lowest-error forecast model (MAE, RMSE, top-5 standalone models, `>=90%` station-tuned matched cohort, all-hours and active-wind rankings for `wind_direction`, and precipitation `HSS` event skill) for a `(lat, lon)` coordinate (H3 Res-7 cell) or `station_or_report_id` across `variable` (`temperature`, `wind_speed`, `wind_direction`, `precipitation`, `humidity`), `lead_day` (`all`, `0`..`7`), and `exclude_commissioned`. |
| **`check_ground_truth_coverage`** | `/api/v1/fact/coverage` (`/api/v1/fact/blind-spot`) | Checks historical WeatherXM FACT station publication coverage for any `(lat, lon)` coordinate or `station_or_report_id` across `variable` (`temperature`, `wind_speed`, `wind_direction`, `precipitation`, `humidity`), returning the nearest evaluated reference cell distance and interactive map citation link. |
| **`get_fact_leaderboard`** | `/api/v1/fact/leaderboard` | Returns global accuracy leaderboards for any of the 5 variables (`temperature`, `wind_speed`, `wind_direction`, `precipitation`, `humidity`; `lead_day`: `0`..`7`, `limit`: `1`..`45`), including MAE/RMSE, circular angular error with an active-wind (`> 3 m/s`) curve for `wind_direction`, and `precipitation_skill` `HSS`/`POD`/`FAR`/`CSI` metrics; or country-level published H3 cell-win summaries (`country`: ISO code or name such as `GR`/`Greece`, `CH`/`Switzerland`, `DE`/`Germany`, `US`). |
| **`get_model_head_to_head`** | `/api/v1/fact/head-to-head` (`/api/v1/fact/compare`) | Compares `1`..`10` models (`models` array) across lead days `0`..`7` for any of the 5 variables (including circular angular error and active-wind curves for `wind_direction`), plus optional localized H3 cell (`lat`, `lon`) matched-cohort and `country` cell-win comparisons. |

### Quick Python Example ([`examples/query_fact_mcp.py`](./examples/query_fact_mcp.py))

```bash
python3 examples/query_fact_mcp.py
python3 examples/verification_formulas.py
```

---

## 6. Repository Structure

```text
weatherxm-fact-mcp/
├── docs/
│   └── FACT_METHODOLOGY.md          # Complete 10-section scientific methodology & limitations
├── examples/
│   ├── verification_formulas.py     # Standalone runnable Python implementation of FACT pooling & HSS math
│   ├── query_fact_mcp.py            # Zero-dependency Python client querying https://fact.weatherxm.com/mcp
│   └── test_stdio_and_scoring.mjs   # Automated test for stdio MCP handshake, tools/list & scoring formulas
├── functions/
│   └── mcp.ts                       # Production Cloudflare Pages Worker MCP & edge handler implementation
├── pipeline/
│   ├── bake_fact_summary.py         # DuckDB continuous MAE/RMSE sample-weighted pooling pipeline
│   ├── bake_precip_skill.py         # 2x2 rain contingency table (HSS, ETS, POD, FAR, CSI) & Poisson bootstrap
│   ├── enrich_cells_top5.py         # Per-cell top-5 non-commissioned & >=90% mLM matched-cohort builder
│   └── bake_mcp_index.mjs           # H3 Res-7 spatial shard & country leaderboard compiler
├── src/
│   └── index.mjs                    # Local stdio MCP server entrypoint (Node >= 18 / Docker)
├── Dockerfile                       # Container image for local stdio / Glama introspection
├── glama.json                       # Glama MCP server manifest
├── server.json                      # Official MCP Registry manifest (com.weatherxm.fact/mcp)
└── LICENSE                          # MIT License (WeatherXM AG)
```

---

## 7. Deploying Live, Rolling 30-Day FACT & Station-Tuned Forecasts at Your Site

The public FACT archive tells you which model *was* best near you in 2025. For an operation that runs on the forecast — a solar or wind asset, a farm, a port, a logistics network, or a trading desk — you want the answer for your exact site, updated every day.

**A WeatherXM station + WeatherXM PRO gives you that:**

| Step | What happens |
| :--- | :--- |
| **1. Deploy a WeatherXM station at your site** | Choose the connectivity that fits the location: **D1** (Wi-Fi), **H2** (LoRaWAN), or **Pulse** (4G cellular). [Compare stations →](https://weatherxm.com/stations/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp) |
| **2. Connect it to [WeatherXM PRO](https://pro.weatherxm.com/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp)** | Your station's quality-checked observations (the same `QoD` pipeline described in §2.2) provide the ground truth for your location. |
| **3. Live, rolling 30-day FACT** | The verification in §2.1–2.4 runs on a rolling 30-day window, recalculated daily, ranking all 45 models against your own sensor for every variable and lead day. Seasonal shifts in which model wins are picked up automatically. |
| **4. Station-tuned forecast at your premise** | A turnkey forecast that blends and calibrates the top-performing models against your station's local truth, delivered through WeatherXM PRO — with no in-house NWP or ML pipeline to build. |

**Next step:** [Get a WeatherXM Station](https://weatherxm.com/stations/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp) · [Explore WeatherXM PRO](https://pro.weatherxm.com/?utm_source=github&utm_medium=readme&utm_campaign=fact_mcp)

---

## License

Released under the [MIT License](./LICENSE) by **WeatherXM AG** ([weatherxm.com](https://weatherxm.com) · [fact.weatherxm.com](https://fact.weatherxm.com)).
