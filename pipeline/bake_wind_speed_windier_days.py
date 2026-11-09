#!/usr/bin/env python3
"""
scripts/bake_wind_speed_windier_days.py

Bakes the optional *windier station-days* conditioned wind_speed subset from the
existing 2025 daily evaluation summaries (data/2025_full, read-only):

  station-day included  <=>  observed_value >= 3.0 m/s   (observed_value is NOT NaN)
                             AND QoD(device, target date) >= 0.80
                             AND n_samples_MAE_RMSE >= 18 hourly pairs
                             AND 0 <= daily_MAE <= 30

Semantics of observed_value (verified in wxm-qof forecast_evaluation/model):
  * hourly observed speed = magnitude of the vector-averaged sub-hourly u/v
    (observations_utils.resample_wind_speed_to_hours), then multiplied by 1.35135
    ("wind 2 m. to wind 10 m. (source: meteoblue)", observations_utils.py) BEFORE
    evaluation;
  * observed_value = daily mean of those (already scaled) hourly values
    (meteorology_utils.calculate_daily_rmse / output_utils).
  So the 3.0 m/s threshold is on the archived SCALED daily mean, not raw anemometer speed
  (inspected reference code provenance, not a pinned 2025 deployment).

This is a conditioned subset (windier days). It is NOT a height correction, NOT an
exposure/siting classifier, NOT a de-biasing step and NOT a preferred ranking.
Conditioning on the observed value also selects days where under-forecasting models
look worse and over-forecasting models look better (conditional-on-observation bias).

Outputs (pooled exactly from per-record sufficient statistics: sum(MAE*n),
sum(RMSE^2*n), sum(n)):
  summary_metrics.json  data.wind_speed.curves_above_3ms[model][lead] =
      {mae, rmse, samples(evaluated records), station_days(distinct device×target date),
       stations(distinct devices), hourly_pairs}
  cells_wind_speed.json  above_3ms per cell/horizon = top-3 non-commissioned models:
      [model, mae, rmse, distinct_stations, distinct_station_days, hourly_pairs]
"""
import argparse
import glob
import json
import os
import time

import duckdb

ROOT = "/Users/manos/Documents/WeatherXM_ALL/FACT"
DATA_DIR = os.path.join(ROOT, "demo/public/data")
BASE_EVAL_DIR = os.path.join(ROOT, "data/2025_full")
SOURCE_QOD = os.path.join(ROOT, "data/qod_daily/*.parquet")

MAX_MAE = 30.0
MIN_SAMPLES = 18
MIN_OBS_WIND_MS = 3.0
MIN_QOD = 0.80
MIN_CURVE_RECORDS = 50          # same HAVING rule as all-hours curves
COMMISSIONED = ("mLM",)


def log(msg):
    print(msg, flush=True)


FILTER_SQL = f"""
    e.variable = 'wind_speed'
    AND e.observed_value IS NOT NULL AND NOT isnan(e.observed_value)
    AND e.observed_value >= {MIN_OBS_WIND_MS}
    AND e.daily_MAE IS NOT NULL AND NOT isnan(e.daily_MAE)
    AND e.daily_MAE BETWEEN 0 AND {MAX_MAE}
    AND e.daily_RMSE IS NOT NULL AND NOT isnan(e.daily_RMSE)
    AND e.n_samples_MAE_RMSE >= {MIN_SAMPLES}
"""
LEAD_SQL = "datediff('day', cast(e.initialization_date as timestamp), cast(e.target_date as timestamp))"


def build(con, eval_glob_for_month, months, qod_glob):
    con.execute(f"""CREATE OR REPLACE TEMP TABLE qod_ok AS
        SELECT DISTINCT cast(date as VARCHAR) d_str, device_id
        FROM read_parquet('{qod_glob}') WHERE qod_score >= {MIN_QOD}""")
    # device-level grain keeps distinct counts exact when merging months
    con.execute("""CREATE OR REPLACE TEMP TABLE dev_lead (
        lead_day INTEGER, cell_id VARCHAR, model VARCHAR, device_id VARCHAR,
        sum_mae_w DOUBLE, sum_mse_w DOUBLE, sum_n DOUBLE, records BIGINT, sdays BIGINT)""")
    con.execute("""CREATE OR REPLACE TEMP TABLE dev_all (
        cell_id VARCHAR, model VARCHAR, device_id VARCHAR, sdays BIGINT)""")
    for ym in months:
        pattern = eval_glob_for_month(ym)
        if not glob.glob(pattern):
            continue
        t = time.time()
        src = f"""(SELECT e.*, {LEAD_SQL} AS lead_day
                   FROM read_parquet('{pattern}', hive_partitioning=true) e
                   SEMI JOIN qod_ok q ON cast(e.date AS VARCHAR) = q.d_str AND e.device_id = q.device_id
                   WHERE {FILTER_SQL} AND {LEAD_SQL} BETWEEN 0 AND 7)"""
        con.execute(f"CREATE OR REPLACE TEMP TABLE m AS SELECT * FROM {src}")
        # partition `date` == target_date, so target dates never repeat across months:
        # per-device distinct day counts are additive across months.
        con.execute("""INSERT INTO dev_lead
            SELECT lead_day, cell_id, model, device_id,
                   sum(daily_MAE*n_samples_MAE_RMSE), sum(daily_RMSE*daily_RMSE*n_samples_MAE_RMSE),
                   sum(n_samples_MAE_RMSE), count(*), count(DISTINCT target_date)
            FROM m GROUP BY ALL""")
        con.execute("""INSERT INTO dev_all
            SELECT cell_id, model, device_id, count(DISTINCT target_date) FROM m GROUP BY ALL""")
        log(f"  [+] {ym} in {time.time()-t:.1f}s")
    con.execute("DROP TABLE IF EXISTS m")


def global_curves(con):
    rows = con.execute(f"""
        SELECT model, lead_day,
               sum(records)::BIGINT records, sum(sdays)::BIGINT sdays,
               count(DISTINCT device_id)::BIGINT stations,
               sum(sum_mae_w)/sum(sum_n) mae, sqrt(sum(sum_mse_w)/sum(sum_n)) rmse,
               sum(sum_n)::BIGINT pairs
        FROM dev_lead GROUP BY model, lead_day
        HAVING sum(records) > {MIN_CURVE_RECORDS}
        ORDER BY model, lead_day""").fetchall()
    out = {}
    for model, lead, rec, sd, st, mae, rmse, pairs in rows:
        out.setdefault(model, {})[str(int(lead))] = {
            "mae": round(float(mae), 3), "rmse": round(float(rmse), 3),
            "samples": int(rec), "station_days": int(sd), "stations": int(st),
            "hourly_pairs": int(pairs)}
    return out


def cell_top3(con):
    excl = ",".join(f"'{m}'" for m in COMMISSIONED)
    rows = con.execute(f"""
        WITH per_lead AS (
            SELECT cast(lead_day AS VARCHAR) lead_key, cell_id, model,
                   sum(sum_mae_w)/sum(sum_n) mae, sqrt(sum(sum_mse_w)/sum(sum_n)) rmse,
                   count(DISTINCT device_id) stations, sum(sdays) sdays, sum(sum_n) pairs
            FROM dev_lead WHERE model NOT IN ({excl}) GROUP BY ALL),
        pooled AS (
            SELECT 'all' lead_key, cell_id, model,
                   sum(sum_mae_w)/sum(sum_n) mae, sqrt(sum(sum_mse_w)/sum(sum_n)) rmse,
                   count(DISTINCT device_id) stations, sum(sum_n) pairs
            FROM dev_lead WHERE model NOT IN ({excl}) GROUP BY ALL),
        pooled_sd AS (
            SELECT cell_id, model, sum(sdays) sdays FROM dev_all
            WHERE model NOT IN ({excl}) GROUP BY ALL),
        u AS (
            SELECT lead_key, cell_id, model, mae, rmse, stations, sdays, pairs FROM per_lead
            UNION ALL
            SELECT p.lead_key, p.cell_id, p.model, p.mae, p.rmse, p.stations, s.sdays, p.pairs
            FROM pooled p JOIN pooled_sd s USING (cell_id, model)),
        r AS (SELECT *, row_number() OVER (PARTITION BY lead_key, cell_id
                     ORDER BY round(mae,2), round(rmse,2), model) rnk FROM u)
        SELECT lead_key, cell_id, model, mae, rmse, stations, sdays, pairs
        FROM r WHERE rnk <= 3 ORDER BY lead_key, cell_id, rnk""").fetchall()
    top = {}
    for lk, cid, model, mae, rmse, st, sd, pairs in rows:
        top.setdefault((lk, cid), []).append(
            [model, round(float(mae), 2), round(float(rmse), 2), int(st), int(sd), int(pairs)])
    return top


SCALING_NOTE = (
    "observed_value is the daily mean of hourly vector-averaged wind speed already multiplied by 1.35135 "
    "(2 m -> 10 m factor, code comment cites meteoblue). curves_above_3ms is the optional 'windier station-days' "
    "subset: station-days whose scaled daily-mean observed wind speed is >= 3.0 m/s (QoD >= 0.80, >= 18 hourly pairs). "
    "It is a conditioned subset, not a height correction, exposure classifier, de-biasing step or preferred ranking."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="compute and print counts; do not write")
    args = ap.parse_args()
    t0 = time.time()
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    con.execute("PRAGMA memory_limit='4GB'")
    months = [f"2025-{m:02d}" for m in range(2, 13)]
    build(con, lambda ym: os.path.join(BASE_EVAL_DIR, f"date={ym}-*", "*.parquet"), months, SOURCE_QOD)
    curves = global_curves(con)
    top = cell_top3(con)
    log(f"[+] curves models={len(curves)} cell-horizon keys={len(top)} in {time.time()-t0:.1f}s")
    if args.dry_run:
        return

    sp = os.path.join(DATA_DIR, "summary_metrics.json")
    summary = json.load(open(sp))
    summary["data"]["wind_speed"]["curves_above_3ms"] = curves
    summary["meta"]["wind_speed"]["scaling_note"] = SCALING_NOTE
    summary["meta"]["wind_speed"]["above_3ms_subset"] = {
        "id": "windier_station_days",
        "rule": "scaled daily-mean observed_value >= 3.0 m/s (NaN excluded), QoD >= 0.80, n_samples >= 18, 0 <= daily_MAE <= 30",
        "samples_basis": "evaluated records (device x model x run x target date)",
        "station_days_basis": "distinct device x target date",
        "stations_basis": "distinct device_id",
    }
    json.dump(summary, open(sp, "w"), indent=2)

    cp = os.path.join(DATA_DIR, "cells_wind_speed.json")
    cells = json.load(open(cp))
    n = 0
    for lk, crow in cells.items():
        for r in crow:
            t3 = top.get((lk, r["cell_id"]))
            if t3:
                r["above_3ms"] = t3
                n += 1
            else:
                r.pop("above_3ms", None)
    json.dump(cells, open(cp, "w"))
    log(f"[+] wrote curves + {n:,} cell-horizon above_3ms entries; total {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
