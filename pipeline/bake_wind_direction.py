#!/usr/bin/env python3
"""
scripts/bake_wind_direction.py

Chunked monthly DuckDB baker for `wind_direction` (circular shortest-arc error in [0°, 180°],
QoD >= 0.80, plus `wind_direction_greater_than_3_m_s` active-wind evaluation).
Processes month-by-month (<400 MB RAM peak, zero disk spill) and merges exact weighted sums.
"""
import os
import glob
import json
import time
import duckdb

DATA_DIR = "/Users/manos/Documents/WeatherXM_ALL/FACT/demo/public/data"
BASE_EVAL_DIR = "/Users/manos/Documents/WeatherXM_ALL/FACT/data/2025_full"
SOURCE_QOD = "/Users/manos/Documents/WeatherXM_ALL/FACT/data/qod_daily/*.parquet"

VAR_NAME = "wind_direction"
VAR_3MS = "wind_direction_greater_than_3_m_s"
MAX_MAE = 180.0
MIN_SAMPLES_ALL = 18
MIN_SAMPLES_3MS = 3


def log(msg):
    print(msg, flush=True)


def main():
    t0 = time.time()
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    con.execute("PRAGMA memory_limit='4GB'")
    con.execute("PRAGMA preserve_insertion_order=false")

    log("[*] Loading distinct QoD >= 0.80 (date, device_id) pairs...")
    con.execute(f"CREATE TEMP TABLE qod_ok AS SELECT DISTINCT cast(date as VARCHAR) as d_str, device_id FROM '{SOURCE_QOD}'")
    log(f"[+] Loaded qod_ok ({con.execute('SELECT count(*) FROM qod_ok').fetchone()[0]:,} unique pairs) in {time.time() - t0:.1f}s")

    with open(os.path.join(DATA_DIR, "cells_wind_speed.json")) as f:
        ws_cells_dict = json.load(f)
    cell_station_counts = {}
    for rows in ws_cells_dict.values():
        for r in rows:
            cid = r['cell_id']
            sc = int(r.get('station_count') or 1)
            if sc > cell_station_counts.get(cid, 0):
                cell_station_counts[cid] = sc

    con.execute("CREATE TEMP TABLE target_cells (cell_id VARCHAR, ws_stations INTEGER)")
    con.executemany("INSERT INTO target_cells VALUES (?, ?)", list(cell_station_counts.items()))

    con.execute("""
        CREATE TEMP TABLE cell_lead_agg (
            variable VARCHAR,
            lead_day INTEGER,
            cell_id VARCHAR,
            model VARCHAR,
            sum_mae_w DOUBLE,
            sum_mse_w DOUBLE,
            sum_samples BIGINT,
            station_days BIGINT
        )
    """)

    months = [f"2025-{m:02d}" for m in range(2, 13)]
    for ym in months:
        m_t0 = time.time()
        pattern = os.path.join(BASE_EVAL_DIR, f"date={ym}-*", "*.parquet")
        if not glob.glob(pattern):
            continue
        con.execute(f"""
            INSERT INTO cell_lead_agg
            SELECT
                e.variable,
                datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) as lead_day,
                e.cell_id,
                e.model,
                sum(e.daily_MAE * e.n_samples_MAE_RMSE) as sum_mae_w,
                sum(e.daily_RMSE * e.daily_RMSE * e.n_samples_MAE_RMSE) as sum_mse_w,
                cast(sum(e.n_samples_MAE_RMSE) as bigint) as sum_samples,
                count(*) as station_days
            FROM read_parquet('{pattern}', hive_partitioning=true) e
            SEMI JOIN qod_ok q ON cast(e.date as VARCHAR) = q.d_str AND e.device_id = q.device_id
            WHERE e.variable IN ('{VAR_NAME}', '{VAR_3MS}')
              AND datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) BETWEEN 0 AND 7
              AND e.daily_MAE BETWEEN 0 AND {MAX_MAE}
              AND (
                  (e.variable = '{VAR_NAME}' AND e.n_samples_MAE_RMSE >= {MIN_SAMPLES_ALL})
                  OR (e.variable = '{VAR_3MS}' AND e.n_samples_MAE_RMSE >= {MIN_SAMPLES_3MS})
              )
            GROUP BY 1, 2, 3, 4
        """)
        log(f"  [+] Processed {ym} in {time.time() - m_t0:.1f}s")

    # Collapse monthly partials into final cell_lead_totals
    con.execute("""
        CREATE TEMP TABLE cell_lead_totals AS
        SELECT
            variable,
            lead_day,
            cell_id,
            model,
            sum(sum_mae_w) as sum_mae_w,
            sum(sum_mse_w) as sum_mse_w,
            cast(sum(sum_samples) as bigint) as sum_samples,
            cast(sum(station_days) as bigint) as station_days
        FROM cell_lead_agg
        GROUP BY 1, 2, 3, 4
    """)
    con.execute("DROP TABLE cell_lead_agg")
    tot_rows = con.execute("SELECT count(*) FROM cell_lead_totals").fetchone()[0]
    log(f"[+] Collapsed cell_lead_totals ({tot_rows:,} rows) in {time.time() - t0:.1f}s total")

    # 1. Global curves
    def build_curves(var_key):
        df = con.execute(f"""
            SELECT
                model,
                lead_day,
                cast(sum(station_days) as bigint) as count,
                round(sum(sum_mae_w) / sum(sum_samples), 3) as pooled_mae,
                round(sqrt(sum(sum_mse_w) / sum(sum_samples)), 3) as pooled_rmse,
                sum(sum_samples) as total_hourly_samples
            FROM cell_lead_totals
            WHERE variable = '{var_key}'
            GROUP BY model, lead_day
            HAVING sum(station_days) > 50
            ORDER BY lead_day, pooled_mae ASC
        """).df()
        models = sorted(df['model'].unique().tolist())
        lead_days = sorted(df['lead_day'].unique().tolist())
        curves = {}
        for m in models:
            m_df = df[df['model'] == m]
            curves[m] = {
                str(int(row['lead_day'])): {
                    'mae': float(row['pooled_mae']),
                    'rmse': float(row['pooled_rmse']),
                    'samples': int(row['count'])
                }
                for _, row in m_df.iterrows()
            }
        return models, [int(d) for d in lead_days], curves

    models, lead_days, curves_all = build_curves(VAR_NAME)
    _, _, curves_3ms = build_curves(VAR_3MS)

    summary_path = os.path.join(DATA_DIR, "summary_metrics.json")
    with open(summary_path) as f:
        summary = json.load(f)

    var_meta = {
        "name": "Wind Direction",
        "unit": "°",
        "icon": "🧭",
        "max_mae": MAX_MAE,
        "min_samples": MIN_SAMPLES_ALL,
        "error_definition": "Circular shortest-arc angular error min(|f - o| mod 360°, 360° - (|f - o| mod 360°)) in [0°, 180°] on hourly unit-vector averages."
    }
    if VAR_NAME not in summary["variables"]:
        summary["variables"].append(VAR_NAME)
    summary["meta"][VAR_NAME] = var_meta
    summary["data"][VAR_NAME] = {
        "models": models,
        "lead_days": lead_days,
        "curves": curves_all,
        "curves_above_3ms": curves_3ms,
        "meta": var_meta
    }
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    log("[+] Updated summary_metrics.json with wind_direction & curves_above_3ms")

    # 2. Top 2,500 H3 cells per lead day + 'all'
    cell_lead_df = con.execute(f"""
        WITH cell_lead_model AS (
            SELECT
                a.lead_day,
                a.cell_id,
                a.model,
                round(a.sum_mae_w / a.sum_samples, 2) as mae,
                coalesce(tc.ws_stations, greatest(1, cast(round(a.station_days / 280.0) as integer))) as stations
            FROM cell_lead_totals a
            LEFT JOIN target_cells tc ON a.cell_id = tc.cell_id
            WHERE a.variable = '{VAR_NAME}'
        ),
        cell_ranks AS (
            SELECT
                lead_day,
                cell_id,
                model as champion_model,
                mae as champion_mae,
                stations,
                row_number() OVER (PARTITION BY lead_day, cell_id ORDER BY mae ASC, model ASC) as rnk
            FROM cell_lead_model
        ),
        cell_spreads AS (
            SELECT
                lead_day,
                cell_id,
                round(max(mae) - min(mae), 2) as spread_mae,
                cast(count(distinct model) as integer) as models_competing
            FROM cell_lead_model
            GROUP BY lead_day, cell_id
        ),
        ranked_cells AS (
            SELECT
                r.lead_day,
                r.cell_id,
                r.champion_model,
                r.champion_mae,
                s.spread_mae,
                s.models_competing,
                r.stations as station_count,
                row_number() OVER (PARTITION BY r.lead_day ORDER BY r.stations DESC, r.champion_mae ASC, r.cell_id ASC) as cell_rnk
            FROM cell_ranks r
            JOIN cell_spreads s ON r.lead_day = s.lead_day AND r.cell_id = s.cell_id
            WHERE r.rnk = 1
        )
        SELECT lead_day, cell_id, champion_model, champion_mae, spread_mae, models_competing, station_count
        FROM ranked_cells
        WHERE cell_rnk <= 2500
        ORDER BY lead_day, cell_rnk ASC
    """).df()

    cell_pooled_df = con.execute(f"""
        WITH cell_pooled_model AS (
            SELECT
                a.cell_id,
                a.model,
                round(sum(a.sum_mae_w) / sum(a.sum_samples), 2) as mae,
                coalesce(max(tc.ws_stations), greatest(1, cast(round(avg(a.station_days) / 280.0) as integer))) as stations
            FROM cell_lead_totals a
            LEFT JOIN target_cells tc ON a.cell_id = tc.cell_id
            WHERE a.variable = '{VAR_NAME}'
            GROUP BY a.cell_id, a.model
        ),
        cell_ranks AS (
            SELECT
                cell_id,
                model as champion_model,
                mae as champion_mae,
                stations,
                row_number() OVER (PARTITION BY cell_id ORDER BY mae ASC, model ASC) as rnk
            FROM cell_pooled_model
        ),
        cell_spreads AS (
            SELECT
                cell_id,
                round(max(mae) - min(mae), 2) as spread_mae,
                cast(count(distinct model) as integer) as models_competing
            FROM cell_pooled_model
            GROUP BY cell_id
        ),
        ranked_cells AS (
            SELECT
                r.cell_id,
                r.champion_model,
                r.champion_mae,
                s.spread_mae,
                s.models_competing,
                r.stations as station_count,
                row_number() OVER (ORDER BY r.stations DESC, r.champion_mae ASC, r.cell_id ASC) as cell_rnk
            FROM cell_ranks r
            JOIN cell_spreads s ON r.cell_id = s.cell_id
            WHERE r.rnk = 1
        )
        SELECT cell_id, champion_model, champion_mae, spread_mae, models_competing, station_count
        FROM ranked_cells
        WHERE cell_rnk <= 2500
        ORDER BY cell_rnk ASC
    """).df()

    cells_dict = {'all': cell_pooled_df.to_dict(orient='records')}
    for d in lead_days:
        sub_df = cell_lead_df[cell_lead_df['lead_day'] == d]
        cells_dict[str(d)] = sub_df[['cell_id', 'champion_model', 'champion_mae', 'spread_mae', 'models_competing', 'station_count']].to_dict(orient='records')

    var_cells = {r['cell_id'] for rows in cells_dict.values() for r in rows}
    con.execute("CREATE TEMP TABLE var_target_cells (cell_id VARCHAR)")
    con.executemany("INSERT INTO var_target_cells VALUES (?)", [(c,) for c in var_cells])

    def fetch_top5_non_comm(var_key):
        rows = con.execute(f"""
            WITH m AS (
                SELECT a.*, coalesce(tc.ws_stations, 1) as stations
                FROM cell_lead_totals a
                JOIN var_target_cells vtc ON a.cell_id = vtc.cell_id
                LEFT JOIN target_cells tc ON a.cell_id = tc.cell_id
                WHERE a.variable = '{var_key}' AND a.model != 'mLM'
            ),
            all_h AS (
                SELECT 'all' as lead_key, cell_id, model,
                       round(sum(sum_mae_w) / sum(sum_samples), 2) as mae,
                       round(sqrt(sum(sum_mse_w) / sum(sum_samples)), 2) as rmse,
                       cast(max(stations) as integer) as stations,
                       cast(round(avg(station_days)) as integer) as station_days,
                       cast(sum(sum_samples) as bigint) as samples
                FROM m
                GROUP BY cell_id, model
                UNION ALL
                SELECT cast(lead_day as varchar) as lead_key, cell_id, model,
                       round(sum_mae_w / sum_samples, 2) as mae,
                       round(sqrt(sum_mse_w / sum_samples), 2) as rmse,
                       cast(stations as integer) as stations,
                       cast(station_days as integer) as station_days,
                       cast(sum_samples as bigint) as samples
                FROM m
            ),
            ranked AS (
                SELECT *, row_number() OVER (PARTITION BY lead_key, cell_id ORDER BY mae ASC, rmse ASC, model ASC) as rnk
                FROM all_h
            )
            SELECT lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk
            FROM ranked WHERE rnk <= 5
            ORDER BY lead_key, cell_id, rnk
        """).fetchall()
        out = {}
        for lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk in rows:
            out.setdefault((lead_key, cell_id), []).append(
                [model, float(mae), float(rmse), int(stations), int(station_days), int(samples)]
            )
        return out

    top_map = fetch_top5_non_comm(VAR_NAME)
    top_3ms_map = fetch_top5_non_comm(VAR_3MS)
    log(f"[+] Computed top_non_comm ({len(top_map):,} keys) and above_3ms ({len(top_3ms_map):,} keys)")

    # 3. mLM matched cohort in the ~48 mLM cells
    mlm_rows = con.execute(f"""
        WITH mlm_cells AS (
            SELECT DISTINCT cell_id FROM cell_lead_totals WHERE variable = '{VAR_NAME}' AND model = 'mLM'
        ),
        m AS (
            SELECT a.*, coalesce(tc.ws_stations, 1) as stations
            FROM cell_lead_totals a
            JOIN mlm_cells mc ON a.cell_id = mc.cell_id
            LEFT JOIN target_cells tc ON a.cell_id = tc.cell_id
            WHERE a.variable = '{VAR_NAME}'
        ),
        all_h AS (
            SELECT 'all' as lead_key, cell_id, model,
                   round(sum(sum_mae_w) / sum(sum_samples), 2) as mae,
                   round(sqrt(sum(sum_mse_w) / sum(sum_samples)), 2) as rmse,
                   cast(max(stations) as integer) as stations,
                   cast(round(avg(station_days)) as integer) as station_days,
                   cast(sum(sum_samples) as bigint) as samples
            FROM m
            GROUP BY cell_id, model
            UNION ALL
            SELECT cast(lead_day as varchar) as lead_key, cell_id, model,
                   round(sum_mae_w / sum_samples, 2) as mae,
                   round(sqrt(sum_mse_w / sum_samples), 2) as rmse,
                   cast(stations as integer) as stations,
                   cast(station_days as integer) as station_days,
                   cast(sum_samples as bigint) as samples
            FROM m
        ),
        ranked AS (
            SELECT *, row_number() OVER (PARTITION BY lead_key, cell_id ORDER BY mae ASC, rmse ASC, model ASC) as rnk
            FROM all_h
        )
        SELECT lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk
        FROM ranked WHERE rnk <= 5 OR model = 'mLM'
        ORDER BY lead_key, cell_id, rnk
    """).fetchall()

    comm_map = {}
    for lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk in mlm_rows:
        entry = comm_map.setdefault((lead_key, cell_id), {'mlm': None, 'matched_top': []})
        rec = [model, float(mae), float(rmse), int(stations), int(station_days), int(samples)]
        if model == 'mLM':
            entry['mlm'] = [float(mae), float(rmse), int(stations), int(station_days), int(samples)]
        if rnk <= 5:
            entry['matched_top'].append(rec)

    for lead_key, rows in cells_dict.items():
        for r in rows:
            cid = r['cell_id']
            top = top_map.get((lead_key, cid), [])
            c = r['champion_model']
            if c != 'mLM' and top and top[0][0] != c:
                idx = next((i for i, t in enumerate(top) if t[0] == c and t[1] == top[0][1]), None)
                if idx is not None:
                    item = top.pop(idx)
                    top.insert(0, item)
                else:
                    r['champion_model'] = top[0][0]
                    r['station_count'] = top[0][3]
            r['top_non_comm'] = top
            c_entry = comm_map.get((lead_key, cid))
            if c_entry and c_entry['mlm']:
                r['comm'] = c_entry
            top3ms = top_3ms_map.get((lead_key, cid), [])
            if top3ms:
                r['above_3ms'] = top3ms[:3]

    with open(os.path.join(DATA_DIR, f"cells_{VAR_NAME}.json"), "w") as f:
        json.dump(cells_dict, f)
    log("[+] Wrote cells_wind_direction.json")

    with open(os.path.join(DATA_DIR, "stations_wind_speed.json")) as f:
        ws_stations = json.load(f)

    stations_dict = {}
    for lead_key, srows in ws_stations.items():
        wd_rows = []
        for sr in srows:
            cid = sr['cell_id']
            top = top_map.get((lead_key, cid), [])
            if not top:
                continue
            best = top[0]
            wd_rows.append({
                'station_id': sr['station_id'],
                'cell_id': cid,
                'champion_model': best[0],
                'champion_mae': best[1],
                'champion_rmse': best[2],
                'total_samples': best[5]
            })
        wd_rows.sort(key=lambda x: (x['champion_mae'], x['station_id']))
        stations_dict[lead_key] = wd_rows[:250]

    with open(os.path.join(DATA_DIR, f"stations_{VAR_NAME}.json"), "w") as f:
        json.dump(stations_dict, f)
    log(f"[+] Wrote stations_wind_direction.json — TOTAL TIME: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
