#!/usr/bin/env python3
"""
scripts/bake_precip_skill.py

Event-based precipitation scores for FACT: did each model get rain/no-rain right?

Average error in mm rewards models that rarely forecast rain, because most days are dry.
This script scores precipitation as an event instead, from the daily 2x2 contingency
classification that the evaluation pipeline already stores in the archive
(column `confusion_matrix`: 0 = hit, 1 = false alarm, 2 = miss, 3 = correct negative,
for a 0.25 mm daily total).

Counts are summed first and scores computed from the totals; per-day scores are never averaged.

Outputs (in OUTPUT_DIR):
  precip_skill.json             Network curves per model and lead day:
                                  HSS (with station-bootstrap 90% interval), POD, FAR, CSI, ETS,
                                  frequency bias, base rate, and mm error split into rain days and
                                  dry days. Computed twice: on every model's own station-days
                                  ("all"), and on matched samples where every model in a
                                  comparison set forecast the same station, run and day ("matched").
  cells_precipitation_skill.json  Per H3 cell and lead day: the model with the highest HSS, among
                                  models with enough rain and dry days in that cell.

Usage:
  python3 scripts/bake_precip_skill.py EVAL_GLOB OUTPUT_DIR [--qod QOD_GLOB] [options]

  python3 scripts/bake_precip_skill.py \
      "data/2025_full/*/*.parquet" demo/public/data \
      --qod "data/qod_daily/*.parquet"
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd

# Network-wide models shown in the headline chart (src/composables/useFactBenchmark.ts HEADLINE_MODELS).
DEFAULT_MATCHED_MODELS = ['MOSAIC', 'METEOBLUE', 'IFS025', 'AIFS025', 'ICON', 'GFS05', 'UMGLOBAL10', 'GEM15']

THRESHOLD_MM = 0.25  # fixed in the evaluation pipeline (wxm-qof MeteorologyUtils.confusion_matrix)


def contingency_scores(a, b, c, d):
    """Scores from summed contingency counts: a hits, b false alarms, c misses, d correct negatives.

    Works on scalars or numpy arrays. Undefined scores (zero denominators) come back as NaN.
    """
    a, b, c, d = (np.asarray(x, dtype=float) for x in (a, b, c, d))
    n = a + b + c + d
    with np.errstate(divide='ignore', invalid='ignore'):
        hss = 2 * (a * d - b * c) / ((a + c) * (c + d) + (a + b) * (b + d))
        a_random = (a + b) * (a + c) / n
        ets = (a - a_random) / (a + b + c - a_random)
        return {
            'hss': hss,
            'ets': ets,
            'pod': a / (a + c),
            'far': b / (a + b),
            'csi': a / (a + b + c),
            'fbi': (a + b) / (a + c),
            'base_rate': (a + c) / n,
        }


def bootstrap_hss(station_counts, n_boot, rng, level=0.90):
    """Percentile interval for HSS, resampling stations (Poisson bootstrap).

    Resampling whole stations keeps each station's days together, so the interval reflects
    that days at one station are not independent.
    station_counts: array of shape (stations, 4) with columns a, b, c, d.
    """
    if len(station_counts) < 2 or n_boot <= 0:
        return np.nan, np.nan
    weights = rng.poisson(1.0, size=(n_boot, len(station_counts)))
    totals = weights @ station_counts  # (n_boot, 4)
    hss = contingency_scores(totals[:, 0], totals[:, 1], totals[:, 2], totals[:, 3])['hss']
    hss = hss[np.isfinite(hss)]
    if len(hss) == 0:
        return np.nan, np.nan
    tail = (1 - level) / 2 * 100
    return float(np.percentile(hss, tail)), float(np.percentile(hss, 100 - tail))


def clean(value, digits=4):
    """JSON-safe rounding: NaN and inf become null."""
    if value is None:
        return None
    value = float(value)
    if not np.isfinite(value):
        return None
    return round(value, digits)


def build_base_view(con, eval_glob, qod_glob, max_lead, max_mae):
    """One row per station, model run, model and target day with a valid rain/no-rain class."""
    qod_join = ''
    if qod_glob:
        con.execute(f"""
            CREATE OR REPLACE VIEW qod_ok AS
            SELECT DISTINCT cast(date AS DATE) AS qod_date, device_id
            FROM read_parquet('{qod_glob}')
        """)
        qod_join = """
            JOIN qod_ok q
              ON q.device_id = e.device_id
             AND q.qod_date = cast(cast(e.target_date AS TIMESTAMP) AS DATE)
        """
    con.execute(f"""
        CREATE OR REPLACE VIEW precip AS
        SELECT
            e.device_id,
            e.cell_id,
            e.model,
            cast(e.initialization_date AS TIMESTAMP) AS init_ts,
            cast(cast(e.target_date AS TIMESTAMP) AS DATE) AS target_day,
            datediff('day', cast(e.initialization_date AS TIMESTAMP), cast(e.target_date AS TIMESTAMP)) AS lead_day,
            cast(try_cast(e.confusion_matrix AS DOUBLE) AS INTEGER) AS cm,
            try_cast(e.daily_MAE AS DOUBLE) AS daily_mae,
            try_cast(e.n_samples_MAE_RMSE AS DOUBLE) AS n_hours
        FROM read_parquet('{eval_glob}', union_by_name = true) e
        {qod_join}
        WHERE e.variable = 'precipitation'
          AND try_cast(e.confusion_matrix AS DOUBLE) IN (0, 1, 2, 3)
          AND datediff('day', cast(e.initialization_date AS TIMESTAMP), cast(e.target_date AS TIMESTAMP))
              BETWEEN 0 AND {max_lead}
          AND (try_cast(e.daily_MAE AS DOUBLE) IS NULL OR try_cast(e.daily_MAE AS DOUBLE) BETWEEN 0 AND {max_mae})
    """)


STATION_AGG_SQL = """
    SELECT
        model,
        lead_day,
        device_id,
        any_value(cell_id) AS cell_id,
        count_if(cm = 0) AS a,
        count_if(cm = 1) AS b,
        count_if(cm = 2) AS c,
        count_if(cm = 3) AS d,
        -- mm error split by what was observed (rain day = hit or miss); daily_mae is mean hourly
        -- absolute error, weighted by its hours, so the result is a mean over hourly pairs
        sum(CASE WHEN cm IN (0, 2) AND daily_mae IS NOT NULL THEN daily_mae * n_hours END) AS wet_err,
        sum(CASE WHEN cm IN (0, 2) AND daily_mae IS NOT NULL THEN n_hours END) AS wet_hours,
        sum(CASE WHEN cm IN (1, 3) AND daily_mae IS NOT NULL THEN daily_mae * n_hours END) AS dry_err,
        sum(CASE WHEN cm IN (1, 3) AND daily_mae IS NOT NULL THEN n_hours END) AS dry_hours
    FROM {source}
    GROUP BY model, lead_day, device_id
"""


def network_curves(station_df, n_boot, rng, min_days):
    """Model x lead-day scores from per-station counts."""
    curves = {}
    for (model, lead), g in station_df.groupby(['model', 'lead_day'], sort=True):
        counts = g[['a', 'b', 'c', 'd']].to_numpy(dtype=float)
        a, b, c, d = counts.sum(axis=0)
        n = a + b + c + d
        if n < min_days:
            continue
        scores = contingency_scores(a, b, c, d)
        lo, hi = bootstrap_hss(counts, n_boot, rng)
        wet_hours, dry_hours = g['wet_hours'].sum(), g['dry_hours'].sum()
        curves.setdefault(model, {})[str(int(lead))] = {
            'n_days': int(n),
            'rain_days_observed': int(a + c),
            'stations': int(len(g)),
            'a_hits': int(a),
            'b_false_alarms': int(b),
            'c_misses': int(c),
            'd_correct_negatives': int(d),
            'hss': clean(scores['hss']),
            'hss_lo': clean(lo),
            'hss_hi': clean(hi),
            'ets': clean(scores['ets']),
            'pod': clean(scores['pod']),
            'far': clean(scores['far']),
            'csi': clean(scores['csi']),
            'fbi': clean(scores['fbi']),
            'base_rate': clean(scores['base_rate']),
            'mae_rain_days': clean(g['wet_err'].sum() / wet_hours) if wet_hours else None,
            'mae_dry_days': clean(g['dry_err'].sum() / dry_hours) if dry_hours else None,
        }
    return curves


def cell_champions(station_df, min_rain_days, min_dry_days, min_models):
    """Per cell and lead day: highest-HSS model among models with enough rain and dry days."""
    cell = (
        station_df.groupby(['lead_day', 'cell_id', 'model'], sort=False)
        .agg(a=('a', 'sum'), b=('b', 'sum'), c=('c', 'sum'), d=('d', 'sum'), stations=('device_id', 'nunique'))
        .reset_index()
    )
    rain = cell['a'] + cell['c']
    dry = cell['b'] + cell['d']
    cell = cell[(rain >= min_rain_days) & (dry >= min_dry_days)].copy()
    cell['hss'] = contingency_scores(cell['a'], cell['b'], cell['c'], cell['d'])['hss']
    cell = cell[np.isfinite(cell['hss'])]

    out = {}
    for (lead, cell_id), g in cell.groupby(['lead_day', 'cell_id'], sort=False):
        if len(g) < min_models:
            continue
        g = g.sort_values('hss', ascending=False)
        best, runner = g.iloc[0], g.iloc[1]
        out.setdefault(str(int(lead)), []).append({
            'cell_id': cell_id,
            'champion_model': best['model'],
            'champion_hss': clean(best['hss']),
            'runner_up_model': runner['model'],
            'runner_up_hss': clean(runner['hss']),
            'spread_hss': clean(best['hss'] - g['hss'].iloc[-1]),
            'models_competing': int(len(g)),
            'station_count': int(g['stations'].max()),
            'rain_days_observed': int(best['a'] + best['c']),
            'n_days': int(best['a'] + best['b'] + best['c'] + best['d']),
        })
    for lead in out:
        out[lead].sort(key=lambda r: (-r['station_count'], -r['rain_days_observed']))
    return out


def bake(eval_glob, output_dir, qod_glob=None, matched_models=None, max_lead=7, max_mae=50.0,
         n_boot=200, min_days=50, cell_min_rain_days=15, cell_min_dry_days=15, cell_min_models=5,
         threads=8, memory_limit=None, seed=20250213):
    start = time.time()
    os.makedirs(output_dir, exist_ok=True)
    matched_models = list(matched_models if matched_models is not None else DEFAULT_MATCHED_MODELS)
    rng = np.random.default_rng(seed)

    con = duckdb.connect()
    con.execute(f"PRAGMA threads={int(threads)}")
    if memory_limit:
        con.execute(f"PRAGMA memory_limit='{memory_limit}'")

    print(f"[*] Reading precipitation records from {eval_glob}" + (f" (QoD gate: {qod_glob})" if qod_glob else ''))
    build_base_view(con, eval_glob, qod_glob, max_lead, max_mae)

    print("[*] Aggregating contingency counts per station (all records)...")
    station_all = con.execute(STATION_AGG_SQL.format(source='precip')).df()
    if station_all.empty:
        raise SystemExit("No precipitation records with a valid rain/no-rain class were found.")

    kpis = con.execute("""
        SELECT count(*), count(DISTINCT device_id), count(DISTINCT cell_id), min(target_day), max(target_day)
        FROM precip
    """).fetchone()

    print(f"[*] Building matched sample for {', '.join(matched_models)}...")
    model_list = ', '.join(f"'{m}'" for m in matched_models)
    # A key is kept only if every model in the set has a valid class for the same station,
    # the same model run time and the same target day. Same run time means same lead hours.
    con.execute(f"""
        CREATE OR REPLACE VIEW precip_matched AS
        WITH keys AS (
            SELECT device_id, init_ts, target_day
            FROM precip
            WHERE model IN ({model_list})
            GROUP BY device_id, init_ts, target_day
            HAVING count(DISTINCT model) = {len(matched_models)}
        )
        SELECT p.*
        FROM precip p
        JOIN keys k USING (device_id, init_ts, target_day)
        WHERE p.model IN ({model_list})
    """)
    station_matched = con.execute(STATION_AGG_SQL.format(source='precip_matched')).df()
    coverage = con.execute(f"""
        SELECT model, lead_day, count(*) AS n
        FROM precip WHERE model IN ({model_list})
        GROUP BY model, lead_day
    """).df()

    print("[*] Computing network curves...")
    curves_all = network_curves(station_all, n_boot, rng, min_days)
    curves_matched = network_curves(station_matched, n_boot, rng, min_days) if not station_matched.empty else {}

    matched_share = {}
    for model in matched_models:
        for lead, point in curves_matched.get(model, {}).items():
            own = coverage[(coverage['model'] == model) & (coverage['lead_day'] == int(lead))]['n'].sum()
            matched_share.setdefault(model, {})[lead] = clean(point['n_days'] / own) if own else None

    summary = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'threshold_mm_per_day': THRESHOLD_MM,
        'qod_gate': bool(qod_glob),
        'kpis': {
            'records': int(kpis[0]),
            'stations': int(kpis[1]),
            'cells': int(kpis[2]),
            'date_start': str(kpis[3]),
            'date_end': str(kpis[4]),
        },
        'definitions': {
            'hss': 'Heidke Skill Score: 1 perfect, 0 no better than chance, negative worse than chance',
            'hss_lo/hss_hi': '90% interval from resampling stations (Poisson bootstrap)',
            'pod': 'Probability of detection: share of observed rain days that were forecast',
            'far': 'False alarm ratio: share of forecast rain days that stayed dry',
            'csi': 'Critical success index: hits / (hits + misses + false alarms)',
            'ets': 'Equitable threat score: CSI corrected for hits expected by chance',
            'fbi': 'Frequency bias: forecast rain days / observed rain days (1 unbiased, <1 too dry)',
            'base_rate': 'Share of days with observed rain',
            'mae_rain_days': 'Mean hourly absolute error (mm) on days with observed rain',
            'mae_dry_days': 'Mean hourly absolute error (mm) on days without observed rain',
        },
        'models': sorted(curves_all.keys()),
        'lead_days': sorted({int(k) for m in curves_all.values() for k in m}),
        'all': curves_all,
        'matched': {
            'models': matched_models,
            'description': 'Only station, model-run and day combinations where every listed model has a valid forecast',
            'share_of_own_records': matched_share,
            'curves': curves_matched,
        },
    }
    summary_path = os.path.join(output_dir, 'precip_skill.json')
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"[+] Wrote {summary_path}")

    print("[*] Computing cell champions by HSS...")
    cells = cell_champions(station_all, cell_min_rain_days, cell_min_dry_days, cell_min_models)
    cells_path = os.path.join(output_dir, 'cells_precipitation_skill.json')
    with open(cells_path, 'w') as f:
        json.dump(cells, f)
    print(f"[+] Wrote {cells_path} ({sum(len(v) for v in cells.values()):,} cell-lead entries)")

    print(f"[*] Done in {time.time() - start:.1f}s")
    return summary, cells


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('eval_glob', help="Evaluation parquet glob, e.g. 'data/2025_full/*/*.parquet'")
    parser.add_argument('output_dir', help='Directory for the JSON outputs, e.g. demo/public/data')
    parser.add_argument('--qod', dest='qod_glob', help="QoD >= 0.8 station-day parquet glob (from sync_qod_table.py)")
    parser.add_argument('--matched-models', default=','.join(DEFAULT_MATCHED_MODELS),
                        help='Comma-separated models for the matched-sample comparison')
    parser.add_argument('--max-lead', type=int, default=7)
    parser.add_argument('--bootstrap', type=int, default=200, help='Bootstrap replicates for the HSS interval (0 to skip)')
    parser.add_argument('--min-days', type=int, default=50, help='Minimum station-days for a model and lead day to be reported')
    parser.add_argument('--cell-min-rain-days', type=int, default=15)
    parser.add_argument('--cell-min-dry-days', type=int, default=15)
    parser.add_argument('--cell-min-models', type=int, default=5)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--memory-limit', default=None, help="DuckDB memory limit, e.g. '14GB'")
    args = parser.parse_args()

    bake(
        args.eval_glob,
        args.output_dir,
        qod_glob=args.qod_glob,
        matched_models=[m.strip() for m in args.matched_models.split(',') if m.strip()],
        max_lead=args.max_lead,
        n_boot=args.bootstrap,
        min_days=args.min_days,
        cell_min_rain_days=args.cell_min_rain_days,
        cell_min_dry_days=args.cell_min_dry_days,
        cell_min_models=args.cell_min_models,
        threads=args.threads,
        memory_limit=args.memory_limit,
    )


if __name__ == '__main__':
    main()
