#!/usr/bin/env node
/** Bakes compact read-only API data from the published demo snapshots, not raw Parquet.
 * Absence from these capped slices never establishes absent/live station coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cellToLatLng } from 'h3-js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'demo/public/data');
const OUT = path.join(SRC, 'mcp');
fs.mkdirSync(OUT, { recursive: true });
const variables = ['temperature', 'wind_speed', 'wind_direction', 'precipitation', 'humidity'];
const sourceFiles = [
  'summary_metrics.json',
  'cell_to_country.json',
  'precip_skill.json',
  'cells_precipitation_skill.json',
  ...variables.map(v => 'cells_' + v + '.json'),
  ...variables.map(v => 'stations_' + v + '.json')
];
const hash = crypto.createHash('sha256');
const sourceHashes = {};
const sources = {};
for (const file of sourceFiles) {
  const bytes = fs.readFileSync(path.join(SRC, file));
  sourceHashes[file] = crypto.createHash('sha256').update(bytes).digest('hex');
  hash.update(file).update(bytes);
  sources[file] = JSON.parse(bytes);
}
const version = 'v2.1-' + hash.digest('hex').slice(0, 16);
const summary = sources['summary_metrics.json'];
const countryMap = sources['cell_to_country.json'];
const models = [...new Set(variables.flatMap(v => summary.data[v].models))].sort();
const modelIndex = new Map(models.map((m, i) => [m, i]));
const countries = [...new Set(Object.values(countryMap))].sort();
const countryIndex = new Map(countries.map((c, i) => [c, i]));
const metaCells = {};
// This is a geography lookup from the archive, NOT a live station inventory.
function ensureCell(id) {
  if (!metaCells[id]) {
    const [lat, lon] = cellToLatLng(id);
    metaCells[id] = [Number(lat.toFixed(6)), Number(lon.toFixed(6)), countryIndex.get(countryMap[id]) ?? null];
  }
}
for (const id of Object.keys(countryMap)) ensureCell(id);
function emit(file, payload) {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > 700_000) throw new Error(file + ' exceeds 700KB uncompressed budget');
  fs.writeFileSync(path.join(OUT, file), text);
  console.log(file + ': ' + Buffer.byteLength(text) + ' bytes');
}
function summarizeCountryRows(rows, countryMap, horizon) {
  const aggregates = {};
  for (const row of rows || []) {
    const country = countryMap[row.cell_id] || 'Unknown';
    const a = aggregates[country] ??= {published_pooled_cells: 0, byModel: {}, byNonCommModel: {}, nonCommCells: 0};
    a.published_pooled_cells++;
    const m = a.byModel[row.champion_model] ??= {cell_wins: 0, maeSum: 0};
    m.cell_wins++;
    m.maeSum += row.champion_mae;
    const ncTop = row.top_non_comm?.[0];
    const ncModel = ncTop ? ncTop[0] : (row.champion_model !== 'mLM' ? row.champion_model : null);
    const ncMae = ncTop ? ncTop[1] : (row.champion_model !== 'mLM' ? row.champion_mae : null);
    if (ncModel && Number.isFinite(ncMae)) {
      a.nonCommCells++;
      const ncm = a.byNonCommModel[ncModel] ??= {cell_wins: 0, maeSum: 0};
      ncm.cell_wins++;
      ncm.maeSum += ncMae;
    }
  }
  const out = {};
  for (const [country, agg] of Object.entries(aggregates)) {
    out[country] = {
      published_pooled_cells: agg.published_pooled_cells,
      horizon,
      metric: 'wins_among_published_pooled_cell_champions',
      note: 'Win shares describe the capped published cells, not national pooled model accuracy. Mean MAE below is over each model\'s winning cells only.',
      winners: Object.entries(agg.byModel).map(([model, m]) => ({model, is_commissioned: model === 'mLM', cell_wins: m.cell_wins, win_share_pct: Number((100 * m.cell_wins / agg.published_pooled_cells).toFixed(2)), mean_mae_on_winning_cells_only: Number((m.maeSum / m.cell_wins).toFixed(3))})).sort((a,b) => b.cell_wins - a.cell_wins || a.model.localeCompare(b.model)),
      winners_excluding_commissioned: Object.entries(agg.byNonCommModel).map(([model, m]) => ({model, is_commissioned: false, cell_wins: m.cell_wins, win_share_pct: Number((100 * m.cell_wins / (agg.nonCommCells || 1)).toFixed(2)), mean_mae_on_winning_cells_only: Number((m.maeSum / m.cell_wins).toFixed(3))})).sort((a,b) => b.cell_wins - a.cell_wins || a.model.localeCompare(b.model))
    };
  }
  return out;
}
const precipCellSkill = sources['cells_precipitation_skill.json'] || {};
const precipCellSkillLookup = {};
for (const [k, rows] of Object.entries(precipCellSkill)) {
  precipCellSkillLookup[k] = Object.fromEntries((rows || []).map(r => [r.cell_id, r]));
}
const countryWins = {};
for (const variable of variables) {
  const slices = sources['cells_' + variable + '.json'];
  const cells = {};
  for (const [lead, rows] of Object.entries(slices)) {
    if (!['all', '0', '1', '2', '3', '4', '5', '6', '7'].includes(lead)) throw new Error('Invalid source horizon');
    for (const row of rows) {
      ensureCell(row.cell_id);
      const i = modelIndex.get(row.champion_model);
      if (i === undefined || !Number.isFinite(row.champion_mae)) throw new Error('Invalid source model/MAE');
      const topNonComm = (row.top_non_comm || []).map(t => {
        const mi = modelIndex.get(t[0]);
        if (mi === undefined) throw new Error('Unknown model in top_non_comm: ' + t[0]);
        return [mi, t[1], t[2], t[3], t[4], t[5]];
      });
      const comm = row.comm && row.comm.mlm
        ? [
            row.comm.mlm,
            (row.comm.matched_top || []).map(t => {
              const mi = modelIndex.get(t[0]);
              if (mi === undefined) throw new Error('Unknown model in matched_top: ' + t[0]);
              return [mi, t[1], t[2], t[3], t[4], t[5]];
            })
          ]
        : null;
      let pSkill = null;
      if (variable === 'precipitation') {
        const skillHorizon = lead === 'all' ? '1' : lead;
        const ps = precipCellSkillLookup[skillHorizon]?.[row.cell_id];
        if (ps) {
          const ci = modelIndex.get(ps.champion_model);
          const ri = ps.runner_up_model ? modelIndex.get(ps.runner_up_model) : null;
          if (ci !== undefined) {
            pSkill = [ci, ps.champion_hss, ri ?? null, ps.runner_up_hss ?? null, ps.spread_hss ?? null, ps.rain_days_observed ?? null, ps.n_days ?? null, skillHorizon];
          }
        }
      } else if (variable === 'wind_direction' && Array.isArray(row.above_3ms) && row.above_3ms.length > 0) {
        pSkill = row.above_3ms.map(t => {
          const mi = modelIndex.get(t[0]);
          if (mi === undefined) throw new Error('Unknown model in above_3ms: ' + t[0]);
          return [mi, t[1], t[2], t[3], t[4], t[5]];
        });
      }
      cells[row.cell_id] ??= {};
      // Only actual source horizon. Never substitute a daily row for pooled 'all'.
      const baseTuple = [i, row.champion_mae, row.spread_mae, row.models_competing ?? null, row.station_count ?? null, topNonComm];
      if (pSkill) baseTuple.push(comm, pSkill);
      else if (comm) baseTuple.push(comm);
      cells[row.cell_id][lead] = baseTuple;
    }
  }
  for (const lead of ['all', '0', '1', '2', '3', '4', '5', '6', '7']) {
    const selected = Object.fromEntries(Object.entries(cells).filter(([, entries]) => entries[lead]).map(([id, entries]) => [id, entries[lead]]));
    emit('shard_' + variable + '_' + lead + '.json', {schema: '2.1', index_version: version, variable, lead_day: lead, unit: summary.meta[variable].unit, cells: selected});
  }
  const obsolete = path.join(OUT, 'shard_' + variable + '.json');
  if (fs.existsSync(obsolete)) fs.unlinkSync(obsolete);
  countryWins[variable] = summarizeCountryRows(slices.all || [], countryMap, 'all');
}
emit('cells_meta.json', {
  schema: '2.1', index_version: version, generated_at: new Date().toISOString(),
  data_as_of: '2025-12-31', evaluation_window: ['2025-02-13', '2025-12-31'],
  methodology_url: 'https://github.com/WeatherXM/weatherxm-fact-mcp/blob/main/docs/FACT_METHODOLOGY.md',
  methodology_note: 'Archive dates and QoD threshold are declared by the published FACT methodology; this re-indexer does not independently revalidate the raw Parquet quality gate.',
  source_hashes: sourceHashes, qod_threshold_declared: 0.8, h3_resolution: 7,
  archive_station_count_declared: summary.global_kpis.total_stations,
  published_pooled_cell_cap: 2500, geography_lookup_cells: Object.keys(countryMap).length,
  coverage_note: 'Historical, capped publication data. Lookup membership is not evidence of current station presence or activity; missing rows mean unpublished or unavailable, not zero stations.',
  models,
  model_names: {
    MOSAIC: 'WeatherXM MOSAIC',
    mLM: 'Meteoblue mLM (Station-Tuned)',
    METEOBLUE: 'Meteoblue',
    IFS025: 'ECMWF IFS',
    IFSHRES: 'ECMWF IFS HRES',
    AIFS025: 'ECMWF AIFS (AI)',
    ICON: 'DWD ICON',
    ICONEU: 'DWD ICON-EU',
    ICOND2: 'DWD ICON-D2',
    GFS05: 'NOAA GFS (0.5°)',
    GFS025: 'NOAA GFS (0.25°)',
    HRRR: 'NOAA HRRR (3 km)',
    NBM: 'NOAA National Blend of Models (NBM)',
    NAM3: 'NOAA NAM 3 km',
    NAM5: 'NOAA NAM 5 km',
    NAM12: 'NOAA NAM 12 km',
    NAMAK: 'NOAA NAM Alaska',
    UMGLOBAL10: 'UK Met Office UM Global (10 km)',
    UKMO2: 'UK Met Office UKV (2 km)',
    GEM15: 'ECCC GEM Global (15 km)',
    GEM2: 'ECCC HRDPS / GEM 2.5 km',
    MFGLOBAL: 'Météo-France ARPEGE Global',
    MFEU: 'Météo-France ARPEGE Europe',
    MFFR: 'Météo-France AROME (1.3 km)',
    NEMSGLOBAL: 'meteoblue NEMS Global',
    NEMSGLOBAL_E: 'meteoblue NEMS Global Ensemble',
    NEMS4: 'meteoblue NEMS 4 km',
    NEMS12: 'meteoblue NEMS 12 km',
    NEMS12_E: 'meteoblue NEMS 12 km Ensemble',
    NEMSAF01: 'meteoblue NEMS Africa',
    NEMSAO01: 'meteoblue NEMS Atlantic',
    NEMSAS02: 'meteoblue NEMS Asia',
    NEMSCAM: 'meteoblue NEMS Central America',
    NEMSIN: 'meteoblue NEMS India',
    NEMSNZ: 'meteoblue NEMS New Zealand',
    NEMSSA: 'meteoblue NEMS South America',
    NMM4: 'meteoblue NMM 4 km',
    NMM22: 'meteoblue NMM 22 km',
    AF01: 'Regional AF01 (Africa)',
    AS01: 'Regional AS01 (Asia)',
    SA01: 'Regional SA01 (South America)',
    COSMOI2: 'COSMO 2 km (Italy)',
    COSMOM5: 'COSMO 5 km',
    HARMONIE: 'HARMONIE-AROME',
    WRFGR: 'WRF Greece',
    WRFAMS: 'WRF Americas',
    MSM: 'JMA MSM (Japan 5 km)'
  },
  commissioned_models: ['mLM'], countries, cells: metaCells
});
emit('country_leaderboards.json', {
  schema: '2.1', index_version: version, global_curves: summary.data,
  precip_skill: sources['precip_skill.json'], countries: countryWins
});
const stationsMap = {};
for (const variable of variables) {
  const stSlices = sources['stations_' + variable + '.json'] || {};
  for (const [lead, rows] of Object.entries(stSlices)) {
    if (!['all', '0', '1', '2', '3', '4', '5', '6', '7'].includes(lead)) continue;
    for (const row of rows) {
      ensureCell(row.cell_id);
      const i = modelIndex.get(row.champion_model);
      if (i === undefined || !Number.isFinite(row.champion_mae)) continue;
      const st = stationsMap[row.station_id] ??= {
        cell_id: row.cell_id,
        country: countryMap[row.cell_id] || null,
        metrics: {}
      };
      st.metrics[variable] ??= {};
      st.metrics[variable][lead] = [i, row.champion_mae, row.champion_rmse ?? null, row.total_samples ?? null];
    }
  }
}
emit('stations_index.json', {
  schema: '2.1',
  index_version: version,
  station_count: Object.keys(stationsMap).length,
  stations: stationsMap
});
