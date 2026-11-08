#!/usr/bin/env python3
"""
scripts/bake_fact_summary.py

Processes recovered FACT evaluation parquet files using DuckDB and generates
compact, pre-baked JSON assets for the Standalone Demo.

Supports:
- Multi-variable: Temperature (°C), Wind Speed (m/s), Precipitation (mm), Relative Humidity (%)
- Multi-horizon: Lead days 0 through 7 + "all" pooled
- Outlier filtering to reject hardware sensor glitches
- Outputs:
  1. demo/public/data/summary_metrics.json (all variables & global curves)
  2. demo/public/data/cells_{variable}.json (keyed by lead_day: 'all', '0'..'7')
  3. demo/public/data/stations_{variable}.json (keyed by lead_day: 'all', '0'..'7')
  4. demo/public/data/h3_cells_champion.json (backward-compatibility fallback)
  5. demo/public/data/stations_leaderboard.json (backward-compatibility fallback)
"""
import os
import sys
import json
import time
import duckdb

VARIABLES = {
    'temperature': {
        'name': 'Temperature',
        'unit': '°C',
        'icon': '🌡️',
        'max_mae': 40.0,
        'min_samples': 18
    },
    'wind_speed': {
        'name': 'Wind Speed',
        'unit': 'm/s',
        'icon': '💨',
        'max_mae': 30.0,
        'min_samples': 18
    },
    'precipitation': {
        'name': 'Precipitation',
        'unit': 'mm',
        'icon': '🌧️',
        'max_mae': 50.0,
        'min_samples': 18
    },
    'humidity': {
        'name': 'Relative Humidity',
        'unit': '%',
        'icon': '💧',
        'max_mae': 100.0,
        'min_samples': 18
    }
}

# Best models kept per cell, so the UI can re-pick the champion when MOSAIC or the commissioned
# forecast (mLM) is toggled off. Three always leaves at least one third-party model.
TOP_MODELS_PER_CELL = 3


def cell_records(df):
    """Cell rows as plain JSON-ready dicts, with `top` as [[model, mae], ...] (most accurate first)."""
    records = []
    for r in df.itertuples(index=False):
        records.append({
            'cell_id': r.cell_id,
            'champion_model': r.champion_model,
            'champion_mae': float(r.champion_mae),
            'spread_mae': float(r.spread_mae),
            'models_competing': int(r.models_competing),
            'station_count': int(r.station_count),
            'worst_mae': round(float(r.worst_mae), 2),
            'top': [[str(m), round(float(e), 2)] for m, e in zip(list(r.top_models), list(r.top_maes))],
        })
    return records


def bake_all(source_glob, output_dir):
    start_total = time.time()
    os.makedirs(output_dir, exist_ok=True)
    con = duckdb.connect()
    con.execute("PRAGMA threads=8")
    
    print(f"[*] Scanning source parquet from: {source_glob}")
    
    # 0. Global Network Counts
    print("[*] Computing overall network metadata...")
    total_stations = int(con.execute(f"SELECT count(distinct device_id) FROM '{source_glob}'").fetchone()[0])
    total_cells = int(con.execute(f"SELECT count(distinct cell_id) FROM '{source_glob}'").fetchone()[0])
    print(f"    Total stations: {total_stations:,} | Total H3 cells: {total_cells:,}")

    multi_summary = {
        'variables': list(VARIABLES.keys()),
        'meta': VARIABLES,
        'global_kpis': {
            'total_stations': total_stations,
            'total_cells': total_cells,
            'archive_window': '2025 Full Year'
        },
        'data': {},
        # Backward compatibility aliases
        'curves': {},
        'models_list': [],
        'lead_days': [0, 1, 2, 3, 4, 5, 6, 7]
    }

    for var_name, var_cfg in VARIABLES.items():
        var_start = time.time()
        print(f"\n==================================================")
        print(f"[*] Processing variable: {var_name.upper()} ({var_cfg['name']} in {var_cfg['unit']})")
        print(f"==================================================")
        
        max_mae = var_cfg['max_mae']
        min_samples = var_cfg['min_samples']
        
        # 1. Global Model Curves across Lead Days (0..7)
        print(f"[*] Computing global curves for {var_name}...")
        curves_df = con.execute(f"""
            SELECT 
                model,
                datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) as lead_day,
                count(*) as count,
                round(sum(daily_MAE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE), 3) as pooled_mae,
                round(sqrt(sum(daily_RMSE * daily_RMSE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE)), 3) as pooled_rmse,
                sum(n_samples_MAE_RMSE) as total_hourly_samples
            FROM '{source_glob}'
            WHERE variable = '{var_name}'
              AND daily_MAE BETWEEN 0 AND {max_mae}
              AND n_samples_MAE_RMSE >= {min_samples}
              AND datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) BETWEEN 0 AND 7
            GROUP BY model, lead_day
            HAVING count > 50
            ORDER BY lead_day, pooled_mae ASC
        """).df()

        models = sorted(curves_df['model'].unique().tolist())
        lead_days = sorted(curves_df['lead_day'].unique().tolist())
        
        curves = {}
        for m in models:
            m_df = curves_df[curves_df['model'] == m]
            curves[m] = {
                int(row['lead_day']): {
                    'mae': float(row['pooled_mae']),
                    'rmse': float(row['pooled_rmse']),
                    'samples': int(row['count'])
                }
                for _, row in m_df.iterrows()
            }
            
        multi_summary['data'][var_name] = {
            'models': models,
            'lead_days': lead_days,
            'curves': curves,
            'meta': var_cfg
        }
        
        # Set temperature as backward-compatible default
        if var_name == 'temperature':
            multi_summary['curves'] = curves
            multi_summary['models_list'] = models
            multi_summary['lead_days'] = lead_days

        # 2. H3 Cell Champions by Lead Day (0..7) + Pooled ('all')
        print(f"[*] Computing H3 cell champions by horizon for {var_name}...")
        cell_lead_df = con.execute(f"""
            WITH cell_lead_model AS (
                SELECT 
                    datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) as lead_day,
                    cell_id,
                    model,
                    round(sum(daily_MAE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE), 2) as mae,
                    count(distinct device_id) as stations
                FROM '{source_glob}'
                WHERE variable = '{var_name}'
                  AND daily_MAE BETWEEN 0 AND {max_mae}
                  AND n_samples_MAE_RMSE >= {min_samples}
                  AND datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) BETWEEN 0 AND 7
                GROUP BY lead_day, cell_id, model
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
                    max(mae) as worst_mae,
                    count(distinct model) as models_competing,
                    list(model ORDER BY mae ASC, model ASC)[1:{TOP_MODELS_PER_CELL}] as top_models,
                    list(mae ORDER BY mae ASC, model ASC)[1:{TOP_MODELS_PER_CELL}] as top_maes
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
                    s.worst_mae,
                    s.models_competing,
                    s.top_models,
                    s.top_maes,
                    r.stations as station_count,
                    row_number() OVER (PARTITION BY r.lead_day ORDER BY r.stations DESC, r.champion_mae ASC) as cell_rnk
                FROM cell_ranks r
                JOIN cell_spreads s ON r.lead_day = s.lead_day AND r.cell_id = s.cell_id
                WHERE r.rnk = 1
            )
            SELECT lead_day, cell_id, champion_model, champion_mae, spread_mae, models_competing, station_count,
                   worst_mae, top_models, top_maes
            FROM ranked_cells
            WHERE cell_rnk <= 2500
            ORDER BY lead_day, cell_rnk ASC
        """).df()

        # Also compute pooled 'all' days champion
        cell_pooled_df = con.execute(f"""
            WITH cell_pooled_model AS (
                SELECT 
                    cell_id,
                    model,
                    round(sum(daily_MAE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE), 2) as mae,
                    count(distinct device_id) as stations
                FROM '{source_glob}'
                WHERE variable = '{var_name}'
                  AND daily_MAE BETWEEN 0 AND {max_mae}
                  AND n_samples_MAE_RMSE >= {min_samples}
                  AND datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) BETWEEN 0 AND 7
                GROUP BY cell_id, model
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
                    max(mae) as worst_mae,
                    count(distinct model) as models_competing,
                    list(model ORDER BY mae ASC, model ASC)[1:{TOP_MODELS_PER_CELL}] as top_models,
                    list(mae ORDER BY mae ASC, model ASC)[1:{TOP_MODELS_PER_CELL}] as top_maes
                FROM cell_pooled_model
                GROUP BY cell_id
            ),
            ranked_cells AS (
                SELECT 
                    r.cell_id,
                    r.champion_model,
                    r.champion_mae,
                    s.spread_mae,
                    s.worst_mae,
                    s.models_competing,
                    s.top_models,
                    s.top_maes,
                    r.stations as station_count,
                    row_number() OVER (ORDER BY r.stations DESC, r.champion_mae ASC) as cell_rnk
                FROM cell_ranks r
                JOIN cell_spreads s ON r.cell_id = s.cell_id
                WHERE r.rnk = 1
            )
            SELECT cell_id, champion_model, champion_mae, spread_mae, models_competing, station_count,
                   worst_mae, top_models, top_maes
            FROM ranked_cells
            WHERE cell_rnk <= 2500
            ORDER BY cell_rnk ASC
        """).df()

        cells_dict = {
            'all': cell_records(cell_pooled_df)
        }
        for d in lead_days:
            sub_df = cell_lead_df[cell_lead_df['lead_day'] == d]
            cells_dict[str(d)] = cell_records(sub_df)

        cell_file = os.path.join(output_dir, f'cells_{var_name}.json')
        with open(cell_file, 'w') as f:
            json.dump(cells_dict, f)
        print(f"[+] Wrote {cell_file} with slices for Days 0..7 and 'all'")

        # Backward compatibility for temperature
        if var_name == 'temperature':
            with open(os.path.join(output_dir, 'h3_cells_champion.json'), 'w') as f:
                json.dump(cells_dict['all'], f)

        # 3. Station Leaderboard by Lead Day (0..7) + Pooled ('all')
        print(f"[*] Computing station leaderboard by horizon for {var_name}...")
        station_lead_df = con.execute(f"""
            WITH station_lead_model AS (
                SELECT 
                    datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) as lead_day,
                    device_id as station_id,
                    cell_id,
                    model,
                    round(sum(daily_MAE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE), 2) as mae,
                    round(sqrt(sum(daily_RMSE * daily_RMSE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE)), 2) as rmse,
                    sum(n_samples_MAE_RMSE) as total_samples
                FROM '{source_glob}'
                WHERE variable = '{var_name}'
                  AND daily_MAE BETWEEN 0 AND {max_mae}
                  AND n_samples_MAE_RMSE >= {min_samples}
                  AND datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) BETWEEN 0 AND 7
                GROUP BY lead_day, device_id, cell_id, model
            ),
            station_ranks AS (
                SELECT 
                    lead_day,
                    station_id,
                    cell_id,
                    model as champion_model,
                    mae as champion_mae,
                    rmse as champion_rmse,
                    total_samples,
                    row_number() OVER (PARTITION BY lead_day, station_id ORDER BY mae ASC) as rnk
                FROM station_lead_model
            ),
            ranked_stations AS (
                SELECT 
                    lead_day,
                    station_id,
                    cell_id,
                    champion_model,
                    champion_mae,
                    champion_rmse,
                    cast(total_samples as integer) as total_samples,
                    row_number() OVER (PARTITION BY lead_day ORDER BY champion_mae ASC) as leader_rank
                FROM station_ranks
                WHERE rnk = 1
            )
            SELECT lead_day, station_id, cell_id, champion_model, champion_mae, champion_rmse, total_samples
            FROM ranked_stations
            WHERE leader_rank <= 250
            ORDER BY lead_day, leader_rank ASC
        """).df()

        station_pooled_df = con.execute(f"""
            WITH station_pooled_model AS (
                SELECT 
                    device_id as station_id,
                    cell_id,
                    model,
                    round(sum(daily_MAE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE), 2) as mae,
                    round(sqrt(sum(daily_RMSE * daily_RMSE * n_samples_MAE_RMSE) / sum(n_samples_MAE_RMSE)), 2) as rmse,
                    sum(n_samples_MAE_RMSE) as total_samples
                FROM '{source_glob}'
                WHERE variable = '{var_name}'
                  AND daily_MAE BETWEEN 0 AND {max_mae}
                  AND n_samples_MAE_RMSE >= {min_samples}
                  AND datediff('day', cast(initialization_date as timestamp), cast(target_date as timestamp)) BETWEEN 0 AND 7
                GROUP BY device_id, cell_id, model
            ),
            station_ranks AS (
                SELECT 
                    station_id,
                    cell_id,
                    model as champion_model,
                    mae as champion_mae,
                    rmse as champion_rmse,
                    total_samples,
                    row_number() OVER (PARTITION BY station_id ORDER BY mae ASC) as rnk
                FROM station_pooled_model
            ),
            ranked_stations AS (
                SELECT 
                    station_id,
                    cell_id,
                    champion_model,
                    champion_mae,
                    champion_rmse,
                    cast(total_samples as integer) as total_samples,
                    row_number() OVER (ORDER BY champion_mae ASC) as leader_rank
                FROM station_ranks
                WHERE rnk = 1
            )
            SELECT station_id, cell_id, champion_model, champion_mae, champion_rmse, total_samples
            FROM ranked_stations
            WHERE leader_rank <= 250
            ORDER BY leader_rank ASC
        """).df()

        stations_dict = {
            'all': station_pooled_df.to_dict(orient='records')
        }
        for d in lead_days:
            sub_df = station_lead_df[station_lead_df['lead_day'] == d]
            stations_dict[str(d)] = sub_df[['station_id', 'cell_id', 'champion_model', 'champion_mae', 'champion_rmse', 'total_samples']].to_dict(orient='records')

        station_file = os.path.join(output_dir, f'stations_{var_name}.json')
        with open(station_file, 'w') as f:
            json.dump(stations_dict, f)
        print(f"[+] Wrote {station_file} with slices for Days 0..7 and 'all'")

        # Backward compatibility for temperature
        if var_name == 'temperature':
            with open(os.path.join(output_dir, 'stations_leaderboard.json'), 'w') as f:
                json.dump(stations_dict['all'], f)

        print(f"[*] Completed {var_name} in {time.time() - var_start:.1f}s")

    # Write multi_summary.json
    summary_file = os.path.join(output_dir, 'summary_metrics.json')
    with open(summary_file, 'w') as f:
        json.dump(multi_summary, f, indent=2)
    print(f"\n[+] Wrote complete {summary_file}")
    print(f"[*] Total bake pipeline finished in {time.time() - start_total:.1f}s!")

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "/Users/manos/Documents/WeatherXM_ALL/FACT/data/2025_full/*/*.parquet"
    out = sys.argv[2] if len(sys.argv) > 2 else "/Users/manos/Documents/WeatherXM_ALL/FACT/demo/public/data"
    bake_all(src, out)
