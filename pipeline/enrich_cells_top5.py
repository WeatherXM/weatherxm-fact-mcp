#!/usr/bin/env python3
"""
scripts/enrich_cells_top5.py

Enriches demo/public/data/cells_{variable}.json (and h3_cells_champion.json) with:
- top_non_comm: Top 5 non-commissioned models ([model, mae, rmse, stations, station_days, hourly_samples])
- comm: Commissioned mLM evaluation and matched station-day cohort ([model, mae, rmse, stations, station_days, hourly_samples])
filtered strictly to station-days with QoD >= 0.8.
"""
import os
import json
import time
import duckdb

DATA_DIR = "/Users/manos/Documents/WeatherXM_ALL/FACT/demo/public/data"
SOURCE_EVAL = "/Users/manos/Documents/WeatherXM_ALL/FACT/data/2025_full/*/*.parquet"
SOURCE_QOD = "/Users/manos/Documents/WeatherXM_ALL/FACT/data/qod_daily/*.parquet"

VARIABLES = {
    'temperature': 40.0,
    'wind_speed': 30.0,
    'precipitation': 50.0,
    'humidity': 100.0,
}


def main():
    t0 = time.time()
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    con.execute("PRAGMA memory_limit='8GB'")
    con.execute("PRAGMA preserve_insertion_order=false")

    con.execute(f"CREATE OR REPLACE VIEW qod_view AS SELECT date, device_id FROM '{SOURCE_QOD}'")
    con.execute(f"""
        CREATE OR REPLACE VIEW eval_filtered AS
        SELECT
            e.target_date,
            e.variable,
            e.model,
            e.daily_MAE,
            e.daily_RMSE,
            e.n_samples_MAE_RMSE,
            e.device_id,
            e.cell_id,
            datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) as lead_day
        FROM '{SOURCE_EVAL}' e
        JOIN qod_view q ON e.date = q.date AND e.device_id = q.device_id
        WHERE datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp)) BETWEEN 0 AND 7
          AND e.n_samples_MAE_RMSE >= 18
          AND e.daily_MAE >= 0
    """)

    t_mlm = time.time()
    mlm_cell_ids = [r[0] for r in con.execute(f"SELECT DISTINCT cell_id FROM '{SOURCE_EVAL}' WHERE model = 'mLM'").fetchall()]
    print(f"[+] Found {len(mlm_cell_ids)} mLM cells in {time.time() - t_mlm:.1f}s")
    con.execute("CREATE TEMP TABLE mlm_cells (cell_id VARCHAR)")
    con.executemany("INSERT INTO mlm_cells VALUES (?)", [(c,) for c in mlm_cell_ids])

    con.execute("""
        CREATE TEMP TABLE mlm_eval_rows AS
        SELECT e.*
        FROM eval_filtered e
        JOIN mlm_cells mc ON e.cell_id = mc.cell_id
    """)
    print(f"[+] Cached mlm_eval_rows ({con.execute('SELECT count(*) FROM mlm_eval_rows').fetchone()[0]:,} rows) in {time.time() - t_mlm:.1f}s")

    for var_name, max_mae in VARIABLES.items():
        vt0 = time.time()
        cell_path = os.path.join(DATA_DIR, f"cells_{var_name}.json")
        with open(cell_path) as f:
            cells_dict = json.load(f)

        var_cells = set()
        for rows in cells_dict.values():
            for r in rows:
                var_cells.add(r['cell_id'])
        con.execute("DROP TABLE IF EXISTS var_target_cells")
        con.execute("CREATE TEMP TABLE var_target_cells (cell_id VARCHAR)")
        con.executemany("INSERT INTO var_target_cells VALUES (?)", [(c,) for c in var_cells])

        lead_rows = con.execute(f"""
            WITH m AS (
                SELECT
                    e.lead_day,
                    e.cell_id,
                    e.model,
                    sum(e.daily_MAE * e.n_samples_MAE_RMSE) as sum_mae_w,
                    sum(e.daily_RMSE * e.daily_RMSE * e.n_samples_MAE_RMSE) as sum_mse_w,
                    sum(e.n_samples_MAE_RMSE) as sum_samples,
                    count(distinct e.device_id) as stations,
                    count(*) as station_days
                FROM eval_filtered e
                JOIN var_target_cells tc ON e.cell_id = tc.cell_id
                WHERE e.variable = '{var_name}' AND e.daily_MAE <= {max_mae} AND e.model != 'mLM'
                GROUP BY e.lead_day, e.cell_id, e.model
            ),
            all_h AS (
                SELECT 'all' as lead_key, cell_id, model,
                       round(sum(sum_mae_w) / sum(sum_samples), 2) as mae,
                       round(sqrt(sum(sum_mse_w) / sum(sum_samples)), 2) as rmse,
                       max(stations) as stations,
                       cast(round(avg(station_days)) as integer) as station_days,
                       cast(sum(sum_samples) as bigint) as samples
                FROM m
                GROUP BY cell_id, model
                UNION ALL
                SELECT cast(lead_day as varchar) as lead_key, cell_id, model,
                       round(sum_mae_w / sum_samples, 2) as mae,
                       round(sqrt(sum_mse_w / sum_samples), 2) as rmse,
                       stations,
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

        mlm_rows = con.execute(f"""
            WITH mlm_lead_pairs AS (
                SELECT DISTINCT lead_day, cell_id, device_id, target_date
                FROM mlm_eval_rows
                WHERE variable = '{var_name}' AND model = 'mLM' AND daily_MAE <= {max_mae}
            ),
            mlm_pooled_pairs AS (
                SELECT DISTINCT cell_id, device_id, target_date
                FROM mlm_lead_pairs
            ),
            agg AS (
                SELECT 'all' as lead_key, e.cell_id, e.model,
                       round(sum(e.daily_MAE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE), 2) as mae,
                       round(sqrt(sum(e.daily_RMSE * e.daily_RMSE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE)), 2) as rmse,
                       count(distinct e.device_id) as stations,
                       count(distinct e.target_date) as station_days,
                       cast(sum(e.n_samples_MAE_RMSE) as bigint) as samples
                FROM mlm_eval_rows e
                JOIN mlm_pooled_pairs mp ON e.cell_id = mp.cell_id AND e.device_id = mp.device_id AND e.target_date = mp.target_date
                WHERE e.variable = '{var_name}' AND e.daily_MAE <= {max_mae}
                GROUP BY e.cell_id, e.model
                UNION ALL
                SELECT cast(e.lead_day as varchar) as lead_key, e.cell_id, e.model,
                       round(sum(e.daily_MAE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE), 2) as mae,
                       round(sqrt(sum(e.daily_RMSE * e.daily_RMSE * e.n_samples_MAE_RMSE) / sum(e.n_samples_MAE_RMSE)), 2) as rmse,
                       count(distinct e.device_id) as stations,
                       count(distinct e.target_date) as station_days,
                       cast(sum(e.n_samples_MAE_RMSE) as bigint) as samples
                FROM mlm_eval_rows e
                JOIN mlm_lead_pairs mf ON e.lead_day = mf.lead_day AND e.cell_id = mf.cell_id AND e.device_id = mf.device_id AND e.target_date = mf.target_date
                WHERE e.variable = '{var_name}' AND e.daily_MAE <= {max_mae}
                GROUP BY e.lead_day, e.cell_id, e.model
            ),
            ranked AS (
                SELECT *, row_number() OVER (PARTITION BY lead_key, cell_id ORDER BY mae ASC, rmse ASC, model ASC) as rnk
                FROM agg
            )
            SELECT lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk
            FROM ranked WHERE rnk <= 5 OR model = 'mLM'
            ORDER BY lead_key, cell_id, rnk
        """).fetchall()

        top_map = {}
        for lead_key, cell_id, model, mae, rmse, stations, station_days, samples, rnk in lead_rows:
            top_map.setdefault((lead_key, cell_id), []).append(
                [model, float(mae), float(rmse), int(stations), int(station_days), int(samples)]
            )

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
                else:
                    r.pop('comm', None)

        with open(cell_path, 'w') as f:
            json.dump(cells_dict, f)
        if var_name == 'temperature':
            with open(os.path.join(DATA_DIR, 'h3_cells_champion.json'), 'w') as f:
                json.dump(cells_dict['all'], f)

        print(f"[+] Enriched {var_name} in {time.time() - vt0:.1f}s")

    print(f"[*] ALL 4 VARIABLES ENRICHED IN {time.time() - t0:.1f}s!")


if __name__ == "__main__":
    main()
