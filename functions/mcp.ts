/** Read-only historical FACT endpoint. No live station inventory, paid calls or secrets. */
import { latLngToCell, cellToLatLng } from 'h3-js';
export interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: any[]): {
      run(): Promise<any>;
    };
  };
}
export interface PagesEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB?: D1DatabaseLike;
}
export type WaitUntilFn = (promise: Promise<any>) => void;

export async function logDemandToD1(
  env: PagesEnv,
  row: {
    transport: string;
    tool: string;
    h3_cell_r7?: string | null;
    country?: string | null;
    variable?: string | null;
    lead_day?: string | null;
    exclude_commissioned?: boolean;
    station_or_report_id?: string | null;
    coverage_status?: string | null;
    champion_model?: string | null;
  }
) {
  console.log(JSON.stringify({ event: 'fact_mcp_demand', ...row }));
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO mcp_demand_logs (transport, tool, h3_cell_r7, country, variable, lead_day, exclude_commissioned, station_or_report_id, coverage_status, champion_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        row.transport,
        row.tool,
        row.h3_cell_r7 ?? null,
        row.country ?? null,
        row.variable ?? null,
        row.lead_day ?? null,
        row.exclude_commissioned ? 1 : 0,
        row.station_or_report_id ?? null,
        row.coverage_status ?? null,
        row.champion_model ?? null
      )
      .run();
  } catch (err) {
    console.warn('D1 mcp_demand_logs insert warning:', err);
  }
}
type Args = Record<string, any>;
const VARIABLES = ['temperature', 'wind_speed', 'wind_direction', 'precipitation', 'humidity'];
const LEADS = ['all', '0', '1', '2', '3', '4', '5', '6', '7'];
const VERSION = '2025-03-26';
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const CACHE = new Map<string, {at: number; value: any}>();
export class InputError extends Error {}
function check(ok: any, message: string): asserts ok { if (!ok) throw new InputError(message); }
function object(value: any): value is Args { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function selection(args: Args, defaultLead = 'all') {
  const variable = args.variable ?? 'temperature';
  const lead = args.lead_day ?? defaultLead;
  check(VARIABLES.includes(variable), 'Invalid variable');
  check(typeof lead === 'string' && LEADS.includes(lead), 'Invalid lead_day');
  check(args.exclude_commissioned === undefined || typeof args.exclude_commissioned === 'boolean', 'exclude_commissioned must be boolean');
  return {variable, lead, exclude: args.exclude_commissioned === true};
}
async function asset(env: PagesEnv, url: string, file: string) {
  const key = new URL(url).origin + '/' + file;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const res = await env.ASSETS.fetch(new Request(new URL('/data/mcp/' + file, url)));
  if (!res.ok) throw new Error('FACT data unavailable');
  const value = await res.json() as any;
  if (value.schema !== '2.1') throw new Error('FACT index version mismatch');
  if (CACHE.size >= 8) CACHE.delete(CACHE.keys().next().value!);
  CACHE.set(key, {at: Date.now(), value});
  return value;
}
function sameVersion(meta: any, other: any) {
  if (meta.index_version !== other.index_version) throw new Error('FACT snapshot mismatch; retry shortly');
}
function provenance(meta: any) {
  return {data_as_of: meta.data_as_of, evaluation_window: meta.evaluation_window,
    index_version: meta.index_version, index_generated_at: meta.generated_at,
    methodology_url: meta.methodology_url,
    methodology_note: meta.methodology_note,
    caveat: 'Historical skill, not a live forecast, guaranteed future accuracy, confidence interval or evidence that buying a station improves accuracy.'};
}
function modelInfo(meta: any, id: string) {
  return {id, name: meta.model_names[id] || id, is_commissioned: meta.commissioned_models.includes(id)};
}
const MATCH_MIN_COVERAGE = 0.9;
function result(meta: any, tuple: any, exclude: boolean, unit: string, variable = 'temperature', lead = 'all'): any {
  if (!tuple) return {status: 'NOT_PUBLISHED_AT_REQUESTED_LEAD', champion_model: null, station_count: null, low_confidence: null, top_non_commissioned_models: [], commissioned_evaluation: null};
  const id = meta.models[tuple[0]];
  const topNonComm = Array.isArray(tuple[5])
    ? tuple[5].map((t: any, idx: number) => ({
        rank: idx + 1,
        ...modelInfo(meta, meta.models[t[0]]),
        mae: t[1],
        rmse: t[2],
        unit,
        station_count: t[3],
        station_days: t[4],
        hourly_samples: t[5]
      }))
    : [];
  const commRaw = tuple[6] || null;
  const commId = meta.commissioned_models[0] || 'mLM';
  let commEval: any = null;
  if (commRaw) {
    const mlmDays = commRaw[0][3];
    const all = (commRaw[1] || []).map((t: any) => ({
      ...modelInfo(meta, meta.models[t[0]]),
      mae: t[1],
      rmse: t[2],
      unit,
      matched_stations: t[3],
      matched_station_days: t[4],
      matched_hourly_samples: t[5],
      coverage_of_commissioned_station_days: mlmDays ? Number((t[4] / mlmDays).toFixed(3)) : null
    }));
    const kept = all
      .filter((t: any) => t.is_commissioned || (t.coverage_of_commissioned_station_days ?? 0) >= MATCH_MIN_COVERAGE)
      .map((t: any, i: number) => ({rank: i + 1, ...t}));
    const mlmRank = kept.find((t: any) => t.is_commissioned)?.rank ?? null;
    commEval = {
      commissioned_model: {
        ...modelInfo(meta, commId),
        mae: commRaw[0][0],
        rmse: commRaw[0][1],
        unit,
        station_count: commRaw[0][2],
        station_days: commRaw[0][3],
        hourly_samples: commRaw[0][4],
        matched_cohort_rank: mlmRank
      },
      matched_cohort_top_models: kept,
      excluded_low_overlap: all.filter((t: any) => !kept.some((k: any) => k.id === t.id)).map((t: any) => t.id),
      note: `Models are scored on the station-days where ${commId} was active in this H3 cell; listed models cover >=${MATCH_MIN_COVERAGE * 100}% of those station-days. Not an hour-level intersection.`
    };
  }

  const isCommChampion = meta.commissioned_models.includes(id);
  const champTop = topNonComm.find((t: any) => t.id === id);
  const excluding = exclude && isCommChampion;
  let champion: any = null;
  let status = 'PUBLISHED_HISTORICAL_CHAMPION';
  if (excluding) {
    champion = topNonComm[0] ?? null;
    status = champion ? 'PUBLISHED_NON_COMMISSIONED_CHAMPION' : 'CELL_RUNNER_UP_NOT_BAKED';
  } else if (isCommChampion && commEval) {
    champion = commEval.commissioned_model;
  } else {
    champion = champTop ?? {...modelInfo(meta, id), mae: tuple[1], unit};
  }

  const worst = tuple[1] + tuple[2];
  const spread = excluding ? (champion ? Number((worst - champion.mae).toFixed(2)) : null) : tuple[2];
  const topMargin = topNonComm.length >= 2 ? Number((topNonComm[1].mae - topNonComm[0].mae).toFixed(2)) : null;
  const tiedWith = champion ? topNonComm.filter((t: any) => t.id !== champion.id && t.mae === champion.mae).map((t: any) => t.id) : [];
  const sc = champion?.station_count ?? tuple[4];
  const sd = champion?.station_days ?? null;
  const modelsCompeting = excluding && tuple[3] !== null ? tuple[3] - 1 : tuple[3];
  const psRaw = tuple[7] || null;
  let precipEventSkill: any = null;
  let windDirAbove3ms: any = null;
  if (variable === 'precipitation' && psRaw) {
    const hssChamp = {...modelInfo(meta, meta.models[psRaw[0]]), hss: psRaw[1]};
    const hssRunner = psRaw[2] !== null ? {...modelInfo(meta, meta.models[psRaw[2]]), hss: psRaw[3]} : null;
    const commChamp = Boolean(hssChamp.is_commissioned);
    const commRunner = Boolean(hssRunner?.is_commissioned);
    const effectiveHssChamp = exclude && commChamp ? hssRunner : hssChamp;
    precipEventSkill = {
      metric: 'Heidke Skill Score (HSS, >=0.2 mm/day rain-event detection; 1.0=perfect, 0=chance)',
      horizon_lead_day: psRaw[7],
      ...(lead === 'all' ? {horizon_substitution_note: 'Pooled HSS is not baked; lead_day=1 HSS is shown.'} : {}),
      effective_hss_champion: effectiveHssChamp,
      ...(exclude ? {} : {overall_hss_champion: hssChamp}),
      runner_up_hss_model: exclude && (commChamp || commRunner) ? null : hssRunner,
      ...(exclude && (commChamp || commRunner) ? {commissioned_hss_withheld: true, runner_up_hss_model_status: 'NOT_BAKED_EXCLUDING_COMMISSIONED'} : {}),
      hss_spread: exclude && commChamp ? null : psRaw[4],
      rain_days_observed: exclude && commChamp ? null : psRaw[5],
      evaluated_station_days: exclude && commChamp ? null : psRaw[6],
      counts_basis: 'champion-model station-days (not matched across models)',
      note: 'For precipitation, categorical event-detection skill (HSS) is more informative than millimeter MAE, which is compressed by dry days and light-rain frequency bias. Prefer effective_hss_champion over MAE for rain-event decisions.'
    };
  } else if (variable === 'wind_direction' && Array.isArray(psRaw) && psRaw.length > 0) {
    const top3ms = psRaw.map((t: any, idx: number) => ({
      rank: idx + 1,
      ...modelInfo(meta, meta.models[t[0]]),
      mae: t[1],
      rmse: t[2],
      circular_mae_deg: t[1],
      circular_rmse_deg: t[2],
      unit: '°',
      station_count: t[3],
      station_days: t[4],
      hourly_samples: t[5]
    }));
    const champ3ms = top3ms[0] ?? null;
    const margin3ms = top3ms.length >= 2 ? Number((top3ms[1].mae - top3ms[0].mae).toFixed(2)) : null;
    const tied3ms = champ3ms ? top3ms.filter((t: any) => t.id !== champ3ms.id && t.mae === champ3ms.mae).map((t: any) => t.id) : [];
    windDirAbove3ms = {
      subset: 'wind_direction_greater_than_3_m_s (hours where observed wind speed > 3 m/s, >= 3 windy hours/day)',
      champion_non_commissioned_model: champ3ms,
      ...(tied3ms.length ? {champion_tied_with: tied3ms} : {}),
      top_non_commissioned_margin_mae: margin3ms,
      low_confidence: champ3ms ? (champ3ms.station_count < 3 || champ3ms.station_days < 60) : null,
      low_confidence_basis: 'Heuristic: <3 stations or <60 station-days in the >3 m/s subset.',
      top_non_commissioned_models: top3ms,
      note: 'Under calm/light winds (<=3 m/s), physical wind vanes wander randomly and NWP flow direction is weakly defined. Prefer wind_direction_above_3ms for active-wind operational decisions.'
    };
  }
  return {
    status,
    champion_model: champion,
    ...(variable === 'wind_direction' ? {
      recommended_basis: windDirAbove3ms?.champion_non_commissioned_model ? 'wind_direction_above_3ms' : 'all_hours',
      preferred_operational_champion: windDirAbove3ms?.champion_non_commissioned_model ?? champion
    } : {}),
    ...(tiedWith.length ? {champion_tied_with: tiedWith} : {}),
    top_non_commissioned_margin_mae: topMargin,
    station_count: sc,
    station_count_basis: 'distinct stations contributing to the champion model, not all stations in the cell',
    low_confidence: sc === null ? null : (sc < 3 || (sd !== null && sd < 60) || (modelsCompeting ?? 0) < 5),
    low_confidence_basis: 'Heuristic: <3 champion stations, <60 champion station-days, or <5 competing models. Not statistical uncertainty.',
    models_competing: modelsCompeting,
    best_to_worst_model_mae_spread: spread,
    top_non_commissioned_models: topNonComm,
    ...(variable === 'precipitation' ? {precipitation_event_skill: precipEventSkill} : {}),
    ...(variable === 'wind_direction' ? {
      wind_direction_methodology: {
        error_formula: 'Circular shortest-arc angular error Δθ = min(|f - o| mod 360°, 360° - (|f - o| mod 360°)) in [0°, 180°] on hourly unit-vector averages (e.g., 359° vs 1° = 2° error, never 358°).',
        rmse_definition: 'Root mean square of the hourly circular shortest-arc errors sqrt((1/n) * sum(Δθ_h^2)).',
        convention: 'Meteorological wind-from bearing in degrees clockwise from true north (0°/360°=N, 90°=E, 180°=S, 270°=W). Hourly observation is the unit-vector average atan2(mean(sin θ), mean(cos θ)); zero-speed calm intervals have undefined direction.',
        random_baseline_deg: 90.0,
        calm_wind_caveat: 'Uniform random direction error averages 90.0° MAE. Primary cell/leaderboard MAE covers all valid hours (>=18h/day), which includes light winds (<=3 m/s) where physical wind vanes wander randomly (~50°–65° MAE). Prefer preferred_operational_champion / wind_direction_above_3ms (>3 m/s active-wind hours) for operational wind decisions.'
      },
      wind_direction_above_3ms: windDirAbove3ms
    } : {}),
    commissioned_evaluation: exclude ? null : commEval,
    ...(exclude && commEval ? {commissioned_evaluation_withheld: true} : {}),
    field_definitions: {
      station_days: 'daily evaluation records (station x model run x target date); can exceed distinct calendar days',
      hourly_samples: 'forecast-observation hourly pairs; summed across lead days when lead_day=all',
      matched_hourly_samples: `hourly pairs on the station-days where ${commId} was active (>=90% station-day overlap); can be higher or lower than ${commId}.hourly_samples when hourly run completeness differs on those same station-days`
    },
    caveat: 'top_non_commissioned_models are evaluated across all QoD>=0.8 stations in the cell; commissioned_evaluation.matched_cohort_top_models compares models covering >=90% of the station-days where mLM was active.'
  };
}
function distance(a: number, b: number, c: number, d: number) {
  const r = Math.PI / 180;
  const x = Math.sin((c-a)*r/2)**2 + Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;
  return 12742.0176 * Math.asin(Math.min(1, Math.sqrt(x)));
}
function links(lat?: number, lon?: number, cellId?: string, variable = 'temperature', lead = 'all') {
  const mapDeepLink =
    lat !== undefined && lon !== undefined
      ? `https://fact.weatherxm.com/?lat=${lat}&lon=${lon}${cellId ? `&cell=${cellId}` : ''}&var=${variable}&lead=${lead}&utm_source=fact_mcp`
      : `https://fact.weatherxm.com/?var=${variable}&lead=${lead}&utm_source=fact_mcp`;
  return {
    interactive_fact_map_url: mapDeepLink,
    weatherxm_pro: 'https://pro.weatherxm.com/?utm_source=fact_mcp',
    agent_api_docs: 'https://agent.weatherxm.com/api',
    meteoblue_business: 'https://content.meteoblue.com/en/business-solutions?utm_source=weatherxm_fact_mcp',
    ...(lat === undefined ? {} : {meteoblue_backed_forecast_access: 'https://agent.weatherxm.com/api/forecast?lat=' + lat + '&lon=' + lon}),
    disclosure: 'WeatherXM sells data and hardware and collaborates with meteoblue. Links are access options, not a recommendation that a provider won this query. Forecast availability, licensing, entitlements and pricing must be checked separately. This connector does not bill or perform paid calls.'
  };
}
function hardware() {
  return {coverage_based_recommendation: null,
    note: 'Archive publication gaps do not establish missing station coverage. For on-site measurements, assess siting, connectivity and data-service compatibility separately; forecast training and improvements are not automatic.',
    stations_overview_url: 'https://weatherxm.com/stations/?utm_source=fact_mcp&utm_medium=ai_connector',
    optional_products: [
      {model: 'WeatherXM D1', connectivity: 'Wi-Fi 2.4 GHz'},
      {model: 'WeatherXM H2', connectivity: 'Network Edition: Helium LoRaWAN coverage required. Open Edition: private LoRaWAN / TTN / ChirpStack; integration required.'},
      {model: 'WeatherXM Pulse', connectivity: 'Cellular gateway with global eSIM; deployment coverage must be checked.'}
    ].map(p => ({...p, url: 'https://weatherxm.com/stations/?utm_source=fact_mcp&utm_medium=ai_connector', price: null}))};
}
export async function handleGetBestForecastModel(env: PagesEnv, url: string, args: Args, waitUntil?: WaitUntilFn, transport = 'mcp', toolName = 'get_best_forecast_model') {
  const hasId = args.station_or_report_id !== undefined;
  check(!hasId || (typeof args.station_or_report_id === 'string' && args.station_or_report_id.trim().length > 0 && args.station_or_report_id.length <= 80), 'Invalid station_or_report_id');
  const hasCoords = args.lat !== undefined || args.lon !== undefined;
  check(hasId || hasCoords, 'Provide (lat, lon) or station_or_report_id');
  if (hasCoords) {
    check(typeof args.lat === 'number' && Number.isFinite(args.lat) && args.lat >= -90 && args.lat <= 90, 'lat must be a number in [-90,90]');
    check(typeof args.lon === 'number' && Number.isFinite(args.lon) && args.lon >= -180 && args.lon <= 180, 'lon must be a number in [-180,180]');
  }
  const {variable, lead, exclude} = selection(args);
  const [meta, shard, stationsIdx] = await Promise.all([
    asset(env,url,'cells_meta.json'),
    asset(env,url,'shard_' + variable + '_' + lead + '.json'),
    hasId ? asset(env,url,'stations_index.json') : Promise.resolve(null)
  ]);
  sameVersion(meta, shard);
  if (stationsIdx) sameVersion(meta, stationsIdx);

  let lat: number | undefined = hasCoords ? args.lat : undefined;
  let lon: number | undefined = hasCoords ? args.lon : undefined;
  let stationOrReportResult: any = undefined;

  if (hasId && stationsIdx) {
    const reqId = args.station_or_report_id.trim();
    const stEntry = stationsIdx.stations?.[reqId];
    if (stEntry) {
      if (lat === undefined || lon === undefined) {
        const [sLat, sLon] = cellToLatLng(stEntry.cell_id);
        lat = Number(sLat.toFixed(6));
        lon = Number(sLon.toFixed(6));
      }
      const queriedCell = latLngToCell(lat!, lon!, 7);
      const locationMismatch = hasCoords && queriedCell !== stEntry.cell_id;
      const mTuple = stEntry.metrics?.[variable]?.[lead] || null;
      const mId = mTuple ? meta.models[mTuple[0]] : null;
      const withheld = Boolean(mId && exclude && meta.commissioned_models.includes(mId));
      stationOrReportResult = {
        id: reqId,
        status: !mTuple ? 'NOT_PUBLISHED_AT_REQUESTED_LEAD' : withheld ? 'STATION_RUNNER_UP_NOT_BAKED' : 'PUBLISHED_STATION_EVALUATION',
        cell_id: stEntry.cell_id,
        country: stEntry.country,
        ...(locationMismatch ? {warning: 'location_mismatch: provided coordinates do not fall inside the station H3 cell'} : {}),
        champion_model: !mTuple || withheld ? null : {...modelInfo(meta, mId), mae: mTuple[1], rmse: mTuple[2], samples: mTuple[3], unit: shard.unit}
      };
    } else {
      stationOrReportResult = {
        id: reqId,
        status: 'CUSTOM_REPORT_OR_STATION_NOT_IN_PUBLIC_SLICE',
        report_lookup_url: `https://fact.weatherxm.com/?${lat !== undefined && lon !== undefined ? `lat=${lat}&lon=${lon}&` : ''}var=${variable}&lead=${lead}&report=${encodeURIComponent(reqId)}&utm_source=fact_mcp`
      };
      if (lat === undefined || lon === undefined) {
        const logP = logDemandToD1(env, {
          transport,
          tool: toolName,
          h3_cell_r7: null,
          country: null,
          variable,
          lead_day: lead,
          exclude_commissioned: exclude,
          station_or_report_id: reqId,
          coverage_status: 'CUSTOM_REPORT_OR_STATION_NOT_IN_PUBLIC_SLICE',
          champion_model: null
        });
        if (waitUntil) waitUntil(logP); else await logP;
        return {
          query: {station_or_report_id: reqId, variable, lead_day: lead, exclude_commissioned: exclude},
          provenance: provenance(meta),
          station_or_report_evaluation: stationOrReportResult,
          optional_station_information: hardware(),
          commercial_access_options: links(undefined, undefined, undefined, variable, lead)
        };
      }
    }
  }

  const id = latLngToCell(lat!, lon!, 7);
  const tuple = shard.cells[id];
  const geo = meta.cells[id];
  // A reference cell is always kept separate from a result at the user's location.
  let nearest: any = null;
  if (!tuple) {
    let min = Infinity;
    for (const [cell, row] of Object.entries<any>(meta.cells)) {
      if (!shard.cells[cell]) continue;
      const km = distance(lat!,lon!,row[0],row[1]);
      if (km < min) { min = km; nearest = {cell_id: cell, country: row[2] === null ? null : meta.countries[row[2]], distance_to_evaluated_cell_centroid_km: Number(km.toFixed(3))}; }
    }
    if (nearest) nearest.historical_result = result(meta, shard.cells[nearest.cell_id], exclude, shard.unit, variable, lead);
  }
  const coverageStatus = tuple ? 'PUBLISHED_HISTORICAL_EVALUATION' : geo ? 'ARCHIVE_LOOKUP_CELL_NO_PUBLISHED_RESULT' : 'NO_ARCHIVE_RESULT_AVAILABLE';
  const cellRes = result(meta, tuple, exclude, shard.unit, variable, lead);
  const logPromise = logDemandToD1(env, {
    transport,
    tool: toolName,
    h3_cell_r7: id,
    country: geo && geo[2] !== null ? meta.countries[geo[2]] : nearest?.country ?? null,
    variable,
    lead_day: lead,
    exclude_commissioned: exclude,
    station_or_report_id: hasId ? args.station_or_report_id.trim() : null,
    coverage_status: coverageStatus,
    champion_model: cellRes.champion_model?.id ?? null
  });
  if (waitUntil) waitUntil(logPromise); else await logPromise;
  return {
    query: {lat: lat!, lon: lon!, h3_cell_r7: id, variable, lead_day: lead, exclude_commissioned: exclude, ...(hasId ? {station_or_report_id: args.station_or_report_id} : {})},
    provenance: {...provenance(meta), interactive_map_citation_url: `https://fact.weatherxm.com/?lat=${lat!}&lon=${lon!}&cell=${id}&var=${variable}&lead=${lead}&utm_source=fact_mcp`},
    ground_truth_coverage: {
      status: coverageStatus,
      current_station_coverage: 'UNKNOWN',
      contributing_stations_in_published_result: tuple
        ? Math.max(tuple[4] ?? 0, ...(cellRes.top_non_commissioned_models || []).map((t: any) => t.station_count ?? 0)) || tuple[4] || null
        : null,
      champion_model_station_count: cellRes.station_count ?? null,
      note: meta.coverage_note
    },
    cell_verification_result: cellRes,
    ...(stationOrReportResult ? {station_or_report_evaluation: stationOrReportResult} : {}),
    nearest_published_reference: nearest,
    reference_note: 'Nearest centroid is not nearest station or cell boundary; a reference in another location/country does not establish skill at the queried location.',
    optional_station_information: hardware(), commercial_access_options: links(lat!,lon!,id,variable,lead)
  };
}
export async function handleCheckGroundTruthCoverage(env: PagesEnv, url: string, args: Args, waitUntil?: WaitUntilFn, transport = 'mcp') {
  const response = await handleGetBestForecastModel(env,url,args,waitUntil,transport,'check_ground_truth_coverage');
  return {...response, scope: 'Historical publication coverage only; current station coverage is not available.'};
}
const COUNTRY_ALIASES: Record<string, string> = {
  GR: 'Greece', GRC: 'Greece', HELLAS: 'Greece',
  CH: 'Switzerland', CHE: 'Switzerland',
  US: 'United States of America', USA: 'United States of America', 'UNITED STATES': 'United States of America',
  UK: 'United Kingdom', GB: 'United Kingdom', GBR: 'United Kingdom', 'GREAT BRITAIN': 'United Kingdom',
  DE: 'Germany', DEU: 'Germany',
  FR: 'France', FRA: 'France',
  IT: 'Italy', ITA: 'Italy',
  ES: 'Spain', ESP: 'Spain',
  NL: 'Netherlands', NLD: 'Netherlands', HOLLAND: 'Netherlands',
  AT: 'Austria', AUT: 'Austria',
  BE: 'Belgium', BEL: 'Belgium',
  PT: 'Portugal', PRT: 'Portugal',
  PL: 'Poland', POL: 'Poland',
  SE: 'Sweden', SWE: 'Sweden',
  NO: 'Norway', NOR: 'Norway',
  DK: 'Denmark', DNK: 'Denmark',
  FI: 'Finland', FIN: 'Finland',
  IE: 'Ireland', IRL: 'Ireland',
  RO: 'Romania', ROU: 'Romania',
  BG: 'Bulgaria', BGR: 'Bulgaria',
  CY: 'Cyprus', CYP: 'Cyprus',
  TR: 'Turkey', TUR: 'Turkey', 'TÜRKIYE': 'Turkey', TURKIYE: 'Turkey',
  SK: 'Slovakia', SVK: 'Slovakia',
  HU: 'Hungary', HUN: 'Hungary',
  CZ: 'Czechia', CZE: 'Czechia', 'CZECH REPUBLIC': 'Czechia',
  HR: 'Croatia', HRV: 'Croatia',
  RS: 'Serbia', SRB: 'Serbia',
  SI: 'Slovenia', SVN: 'Slovenia',
  LT: 'Lithuania', LTU: 'Lithuania',
  LV: 'Latvia', LVA: 'Latvia',
  EE: 'Estonia', EST: 'Estonia',
  LU: 'Luxembourg', LUX: 'Luxembourg',
  MT: 'Malta', MLT: 'Malta',
  IS: 'Iceland', ISL: 'Iceland',
  UA: 'Ukraine', UKR: 'Ukraine',
  AE: 'United Arab Emirates', ARE: 'United Arab Emirates', UAE: 'United Arab Emirates',
  KE: 'Kenya', KEN: 'Kenya',
  NG: 'Nigeria', NGA: 'Nigeria',
  JP: 'Japan', JPN: 'Japan',
  AU: 'Australia', AUS: 'Australia',
  CA: 'Canada', CAN: 'Canada',
  BR: 'Brazil', BRA: 'Brazil',
  IN: 'India', IND: 'India',
  MX: 'Mexico', MEX: 'Mexico',
  ZA: 'South Africa', ZAF: 'South Africa',
  KR: 'South Korea', KOR: 'South Korea', KOREA: 'South Korea',
  NZ: 'New Zealand', NZL: 'New Zealand',
  SG: 'Singapore', SGP: 'Singapore',
  TW: 'Taiwan', TWN: 'Taiwan',
  TH: 'Thailand', THA: 'Thailand',
  PH: 'Philippines', PHL: 'Philippines',
  ID: 'Indonesia', IDN: 'Indonesia',
  MY: 'Malaysia', MYS: 'Malaysia',
  VN: 'Vietnam', VNM: 'Vietnam',
  AR: 'Argentina', ARG: 'Argentina',
  CL: 'Chile', CHL: 'Chile',
  CO: 'Colombia', COL: 'Colombia',
  PE: 'Peru', PER: 'Peru'
};
export async function handleGetFactLeaderboard(env: PagesEnv, url: string, args: Args) {
  check(args.country === undefined || (typeof args.country === 'string' && args.country.trim().length > 0 && args.country.length <= 80), 'Invalid country');
  check(args.limit === undefined || (typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 45), 'limit must be an integer in [1,45]');
  const limit = args.limit ?? 45;
  const {variable, lead, exclude} = selection(args, args.country ? 'all' : '1');
  const [meta, lb] = await Promise.all([asset(env,url,'cells_meta.json'), asset(env,url,'country_leaderboards.json')]);
  sameVersion(meta,lb);
  const commLinks = links(undefined, undefined, undefined, variable, lead);
  const prov = {...provenance(meta), interactive_map_citation_url: commLinks.interactive_fact_map_url};
  if (args.country) {
    const rawCountry = args.country.trim();
    const mappedCountry = COUNTRY_ALIASES[rawCountry.toUpperCase()] ?? rawCountry;
    const name = Object.keys(lb.countries[variable]).find(c => c !== 'Unknown' && c.toLowerCase() === mappedCountry.toLowerCase());
    check(name, `Country "${rawCountry}" is not present in the published slice; use an exact country name or ISO code (e.g. Greece/GR, Switzerland/CH, Germany/DE, United States of America/US)`);
    if (lead === 'all') {
      const cEntry = lb.countries[variable][name];
      const baseWinners = exclude ? (cEntry.winners_excluding_commissioned ?? []) : (cEntry.winners ?? []);
      const effectiveCells = baseWinners.reduce((sum: number, w: any) => sum + (w.cell_wins ?? 0), 0);
      return {provenance: prov, country: name, variable, lead_day: lead,
        country_published_cell_wins: {
          published_pooled_cells: exclude ? effectiveCells : cEntry.published_pooled_cells,
          horizon: cEntry.horizon,
          metric: exclude ? 'wins_among_published_pooled_non_commissioned_cell_champions' : cEntry.metric,
          note: cEntry.note,
          total_winning_models: baseWinners.length,
          winners: baseWinners.slice(0, limit)
        },
        status: effectiveCells === 0
          ? 'NO_PUBLISHED_CELLS_AT_REQUESTED_LEAD'
          : exclude ? 'PUBLISHED_NON_COMMISSIONED_CELL_WIN_SUMMARY' : 'PUBLISHED_CELL_WIN_SUMMARY',
        note: 'Win shares describe the capped published cells in this country. For site-specific top-5 MAE/RMSE and matched-cohort comparisons, call get_best_forecast_model with coordinates.', commercial_access_options: commLinks};
    }
    const shard = await asset(env, url, 'shard_' + variable + '_' + lead + '.json');
    sameVersion(meta, shard);
    const countryIdx = meta.countries.indexOf(name);
    const byModel: Record<string, {cell_wins: number; maeSum: number}> = {};
    let totalCells = 0;
    for (const [cellId, tuple] of Object.entries<any>(shard.cells)) {
      const geo = meta.cells[cellId];
      if (!geo || geo[2] !== countryIdx) continue;
      let mId = meta.models[tuple[0]];
      let mae = tuple[1];
      if (exclude && meta.commissioned_models.includes(mId)) {
        const nc = tuple[5]?.[0];
        if (!nc) continue;
        mId = meta.models[nc[0]];
        mae = nc[1];
      }
      totalCells++;
      const entry = byModel[mId] ??= {cell_wins: 0, maeSum: 0};
      entry.cell_wins++;
      entry.maeSum += mae;
    }
    const winners = Object.entries(byModel)
      .map(([model, m]) => ({
        model,
        is_commissioned: meta.commissioned_models.includes(model),
        cell_wins: m.cell_wins,
        win_share_pct: totalCells ? Number((100 * m.cell_wins / totalCells).toFixed(2)) : 0,
        mean_mae_on_winning_cells_only: Number((m.maeSum / m.cell_wins).toFixed(3))
      }))
      .sort((a, b) => b.cell_wins - a.cell_wins || a.model.localeCompare(b.model));
    return {
      provenance: prov,
      country: name,
      variable,
      lead_day: lead,
      country_published_cell_wins: {
        published_pooled_cells: totalCells,
        published_cells_at_lead: totalCells,
        horizon: lead,
        metric: exclude ? 'wins_among_published_lead_day_non_commissioned_cell_champions' : 'wins_among_published_lead_day_cell_champions',
        note: totalCells === 0
          ? `No published H3 cells in ${name} have a baked evaluation at lead_day=${lead} for ${variable}.`
          : 'Win shares describe the capped published cells in this country at lead_day=' + lead + '. Mean MAE below is over each model\'s winning cells only.',
        total_winning_models: winners.length,
        winners: winners.slice(0, limit)
      },
      status: totalCells === 0
        ? 'NO_PUBLISHED_CELLS_AT_REQUESTED_LEAD'
        : exclude ? 'PUBLISHED_NON_COMMISSIONED_CELL_WIN_SUMMARY' : 'PUBLISHED_CELL_WIN_SUMMARY',
      note: 'Win shares describe the capped published cells in this country. For site-specific top-5 MAE/RMSE and matched-cohort comparisons, call get_best_forecast_model with coordinates.',
      commercial_access_options: commLinks
    };
  }
  check(lead !== 'all', 'Global curves require a specific lead_day (0..7); pooled all is not baked');
  const curves = lb.global_curves[variable].curves;
  const rows = Object.entries<any>(curves).filter(([id,c]) => c[lead] && (!exclude || !meta.commissioned_models.includes(id)))
    .map(([id,c]) => ({...modelInfo(meta,id), ...c[lead], sample_count_basis: 'source curves.samples counts station/model/target/run daily evaluation records, not unique stations or hourly pairs'}))
    .sort((a,b) => a.mae-b.mae);
  const precipAll = variable === 'precipitation'
    ? Object.entries<any>(lb.precip_skill.all)
        .filter(([id,c]) => c[lead] && (!exclude || !meta.commissioned_models.includes(id)))
        .map(([id,c]) => ({...modelInfo(meta,id), ...c[lead]}))
        .sort((a,b) => (b.hss ?? -Infinity) - (a.hss ?? -Infinity) || a.id.localeCompare(b.id))
    : [];
  const wind3msCurves = variable === 'wind_direction' ? (lb.global_curves[variable]?.curves_above_3ms ?? {}) : {};
  const wind3msAll = variable === 'wind_direction'
    ? Object.entries<any>(wind3msCurves)
        .filter(([id,c]) => c[lead] && (!exclude || !meta.commissioned_models.includes(id)))
        .map(([id,c]) => ({...modelInfo(meta,id), ...c[lead], unit: '°', sample_count_basis: 'station-days with >=3 hours of observed wind speed > 3 m/s'}))
        .sort((a,b) => a.mae - b.mae || a.id.localeCompare(b.id))
    : [];
  return {provenance: prov, variable, lead_day: lead,
    total_models_evaluated: rows.length,
    returned_models_count: Math.min(rows.length, limit),
    leaderboard: rows.slice(0, limit),
    comparability_note: 'Models have different sample cohorts. Filtering mLM does not create matched station/time cohorts. MAE and RMSE are historical errors, not confidence intervals.',
    ...(variable === 'wind_direction' ? {
      wind_direction_methodology: {
        error_formula: 'Circular shortest-arc angular error min(|f - o| mod 360°, 360° - (|f - o| mod 360°)) in [0°, 180°] on hourly unit-vector averages (e.g., 359° vs 1° = 2° error, never 358°).',
        subset_comparison_note: 'leaderboard covers all valid hours (>=18h/day); wind_direction_above_3ms filters to hours with observed wind speed > 3 m/s (>=3 windy hours/day) to eliminate calm-wind vane wander.'
      },
      wind_direction_above_3ms: {
        threshold: '>3 m/s observed wind speed (>=3 valid windy hours/day)',
        total_models_evaluated: wind3msAll.length,
        returned_models_count: Math.min(wind3msAll.length, limit),
        leaderboard: wind3msAll.slice(0, limit)
      }
    } : {}),
    precipitation_skill: variable === 'precipitation' ? {
      threshold_mm_per_day: lb.precip_skill.threshold_mm_per_day,
      sort_order: 'hss_desc',
      total_models_evaluated: precipAll.length,
      returned_models_count: Math.min(precipAll.length, limit),
      metrics: precipAll.slice(0, limit)
    } : null, commercial_access_options: commLinks};
}
const MODEL_ALIASES: Record<string, string> = {
  GFS025: 'GFS05',
  GFS: 'GFS05',
  ECMWF: 'IFS025',
  IFS: 'IFS025',
  AIFS: 'AIFS025',
  'ICON-EU': 'ICONEU',
  'ICON-D2': 'ICOND2',
  MLM: 'mLM',
  METEOBLUE_MLM: 'mLM',
  'METEOBLUE-MLM': 'mLM',
  UKMO: 'UMGLOBAL10',
  GEM: 'GEM15',
  ARPEGE: 'MFGLOBAL',
  AROME: 'MFFR'
};
export async function handleGetModelHeadToHead(env: PagesEnv, url: string, args: Args) {
  const {variable, lead, exclude} = selection(args, 'all');
  check(args.country === undefined || (typeof args.country === 'string' && args.country.trim().length > 0 && args.country.length <= 80), 'Invalid country');
  const hasLat = args.lat !== undefined;
  const hasLon = args.lon !== undefined;
  check(hasLat === hasLon, 'Provide both lat and lon when filtering by coordinates');
  if (hasLat) {
    check(typeof args.lat === 'number' && Number.isFinite(args.lat) && args.lat >= -90 && args.lat <= 90, 'lat must be a number in [-90,90]');
    check(typeof args.lon === 'number' && Number.isFinite(args.lon) && args.lon >= -180 && args.lon <= 180, 'lon must be a number in [-180,180]');
  }
  const rawModels = args.models ?? ['MOSAIC','METEOBLUE','mLM','IFS025','GFS05'];
  check(Array.isArray(rawModels) && rawModels.length > 0 && rawModels.length <= 10 && rawModels.every(m => typeof m === 'string' && m.length <= 40), 'models must contain 1..10 model IDs');
  const [meta,lb] = await Promise.all([asset(env,url,'cells_meta.json'),asset(env,url,'country_leaderboards.json')]);
  sameVersion(meta,lb);
  const curves = lb.global_curves[variable].curves;
  const resolvedAliases: Record<string, string> = {};
  const resolutionWarnings: string[] = [];
  const resolvedIds: string[] = [];
  for (const raw of rawModels) {
    const trimmed = raw.trim();
    const upper = trimmed.toUpperCase();
    const exact = meta.models.find((m: string) => m.toUpperCase() === upper);
    const mapped = exact ?? MODEL_ALIASES[upper];
    check(mapped && meta.models.includes(mapped), `Unknown model ID: ${raw}. Valid model IDs: ${meta.models.join(', ')}`);
    if (mapped.toUpperCase() !== upper) resolvedAliases[raw] = mapped;
    if (upper === 'GFS025') {
      resolutionWarnings.push('GFS025 (0.25°) is not present in FACT published data; returning GFS05 (NOAA GFS 0.5°) as the closest archived NOAA GFS series — do not treat as a 0.25° resolution equivalence.');
    }
    if (!resolvedIds.includes(mapped)) resolvedIds.push(mapped);
  }
  const filteredIds = exclude ? resolvedIds.filter(id => !meta.commissioned_models.includes(id)) : resolvedIds;

  let localCellComparison: any = undefined;
  let cellIdForLink: string | undefined = undefined;
  let cellCountryName: string | null = null;
  if (hasLat) {
    const cellId = latLngToCell(args.lat, args.lon, 7);
    cellIdForLink = cellId;
    const cellGeo = meta.cells[cellId];
    cellCountryName = cellGeo && cellGeo[2] !== null ? meta.countries[cellGeo[2]] : null;
    const shard = await asset(env, url, 'shard_' + variable + '_' + lead + '.json');
    sameVersion(meta, shard);
    const tuple = shard.cells[cellId];
    const cellRes = result(meta, tuple, exclude, shard.unit, variable, lead);
    const nonCommById = new Map((cellRes.top_non_commissioned_models || []).map((m: any) => [m.id, m]));
    const matchedById = new Map((cellRes.commissioned_evaluation?.matched_cohort_top_models || []).map((m: any) => [m.id, m]));
    localCellComparison = {
      h3_cell_r7: cellId,
      cell_country: cellCountryName,
      lead_day: lead,
      exclude_commissioned: exclude,
      status: cellRes.status,
      cell_champion_model: cellRes.champion_model,
      requested_models_in_cell: filteredIds.map((id: string) => ({
        ...modelInfo(meta, id),
        in_top_5_non_commissioned: nonCommById.get(id) ?? null,
        ...(variable === 'wind_direction' && cellRes.wind_direction_above_3ms ? {
          in_top_above_3ms_non_commissioned: (cellRes.wind_direction_above_3ms.top_non_commissioned_models || []).find((m: any) => m.id === id) ?? null
        } : {}),
        in_commissioned_matched_cohort: exclude ? null : (matchedById.get(id) ?? (cellRes.commissioned_evaluation?.commissioned_model?.id === id ? cellRes.commissioned_evaluation.commissioned_model : null))
      })),
      ...(variable === 'wind_direction' && cellRes.wind_direction_above_3ms ? {wind_direction_above_3ms: cellRes.wind_direction_above_3ms} : {}),
      note: cellRes.status === 'NOT_PUBLISHED_AT_REQUESTED_LEAD'
        ? 'No published historical evaluation is baked for this H3 cell at the requested lead_day; requested model entries are null because the cell itself has no published slice.'
        : 'Cell slices bake the cell champion, top-5 non-commissioned models, and (where mLM is active) top matched-cohort models covering >=90% of mLM station-days. A null entry means the model did not place in that baked cell top-5 slice, not that it was unmeasured.'
    };
  }

  let countryComparison: any = undefined;
  if (args.country) {
    const cLb = await handleGetFactLeaderboard(env, url, {country: args.country, variable, lead_day: lead, exclude_commissioned: exclude, limit: 45});
    const winnersById = new Map((cLb.country_published_cell_wins?.winners || []).map((w: any) => [w.model, w]));
    countryComparison = {
      country: cLb.country,
      status: cLb.status,
      lead_day: lead,
      exclude_commissioned: exclude,
      published_pooled_cells: cLb.country_published_cell_wins?.published_pooled_cells ?? 0,
      metric: cLb.country_published_cell_wins?.metric,
      requested_models_cell_wins: filteredIds.map((id: string) => winnersById.get(id) ?? {
        model: id,
        is_commissioned: meta.commissioned_models.includes(id),
        cell_wins: 0,
        win_share_pct: 0,
        mean_mae_on_winning_cells_only: null
      }),
      note: cLb.country_published_cell_wins?.note
    };
  }

  const curves3ms = variable === 'wind_direction' ? (lb.global_curves[variable]?.curves_above_3ms ?? {}) : null;
  const countryCoordMismatch = Boolean(cellCountryName && countryComparison?.country && cellCountryName !== countryComparison.country);
  const commLinks = links(hasLat ? args.lat : undefined, hasLon ? args.lon : undefined, cellIdForLink, variable, lead);
  const hasLocalOrCountry = Boolean(localCellComparison || countryComparison);
  return {
    provenance: {...provenance(meta), interactive_map_citation_url: commLinks.interactive_fact_map_url},
    scope: hasLocalOrCountry ? 'global published curves plus requested local/country comparison' : 'global published curves only',
    variable,
    ...(variable === 'wind_direction' ? {
      wind_direction_methodology: {
        error_formula: 'Circular shortest-arc angular error min(|f - o| mod 360°, 360° - (|f - o| mod 360°)) in [0°, 180°] on hourly unit-vector averages (e.g., 359° vs 1° = 2° error, never 358°).',
        calm_wind_caveat: 'lead_days covers all valid hours (>=18h/day); lead_days_above_3ms filters to hours with observed wind speed > 3 m/s (>=3 windy hours/day) to eliminate calm-wind vane wander.'
      }
    } : {}),
    ...(args.lead_day !== undefined ? {lead_day: lead} : {}),
    ...(args.exclude_commissioned !== undefined ? {exclude_commissioned: exclude} : {}),
    ...(exclude && filteredIds.length === 0 ? {commissioned_models_excluded_warning: 'All requested models were station-commissioned and excluded by exclude_commissioned=true.'} : {}),
    ...(countryCoordMismatch ? {country_coordinate_mismatch_warning: `Provided coordinates fall in H3 cell ${cellIdForLink} (${cellCountryName}), which differs from requested country "${countryComparison.country}".`} : {}),
    ...(Object.keys(resolvedAliases).length ? {resolved_model_aliases: resolvedAliases} : {}),
    ...(resolutionWarnings.length ? {resolution_substitution_warning: resolutionWarnings[0]} : {}),
    models: filteredIds.map((id: string) => {
      const hasAnyCurve = Boolean(curves[id] && Object.keys(curves[id]).length > 0);
      const hasRequestedLead = lead === 'all' ? hasAnyCurve : Boolean(curves[id]?.[lead]);
      return {
        ...modelInfo(meta,id),
        status: !hasAnyCurve
          ? 'NO_GLOBAL_CURVE_FOR_VARIABLE'
          : !hasRequestedLead
          ? 'NO_GLOBAL_CURVE_AT_REQUESTED_LEAD'
          : 'PUBLISHED_GLOBAL_CURVE',
        ...(args.lead_day !== undefined && lead !== 'all' ? {requested_lead_day_metrics: curves[id]?.[lead] ?? null} : {}),
        ...(curves3ms && args.lead_day !== undefined && lead !== 'all' ? {requested_lead_day_above_3ms_metrics: curves3ms[id]?.[lead] ?? null} : {}),
        lead_days: hasAnyCurve ? curves[id] : null,
        ...(curves3ms ? {lead_days_above_3ms: curves3ms[id] && Object.keys(curves3ms[id]).length > 0 ? curves3ms[id] : null} : {})
      };
    }),
    ...(localCellComparison ? {local_cell_comparison: localCellComparison} : {}),
    ...(countryComparison ? {country_comparison: countryComparison} : {}),
    comparability_note: 'Global curves are source-specific cohorts, not a matched-sample head-to-head. When local_cell_comparison is present, in_commissioned_matched_cohort compares models covering >=90% of mLM active station-days in that H3 cell. mLM is station-commissioned; MOSAIC is WeatherXM post-processing.',
    commercial_access_options: commLinks
  };
}
const geo = {lat: {type:'number',minimum:-90,maximum:90},lon:{type:'number',minimum:-180,maximum:180}};
const common = {variable:{type:'string',enum:VARIABLES,default:'temperature'},lead_day:{type:'string',enum:LEADS},exclude_commissioned:{type:'boolean',default:false}};
const stationOrReportProp = {station_or_report_id:{type:'string',maxLength:80,description:'Optional WeatherXM station UUID or custom site evaluation report ID (e.g. STUDY-...)'}};
const annotations = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const ALL_45_MODELS_TEXT = 'All 45 FACT models: WeatherXM MOSAIC (MOSAIC), meteoblue (METEOBLUE), meteoblue station-mLM (mLM), ECMWF IFS (IFS025, IFSHRES), ECMWF AIFS AI (AIFS025), NOAA GFS (GFS05, GFS025), NOAA HRRR (HRRR), NOAA National Blend of Models (NBM), NOAA NAM (NAM3, NAM5, NAM12, NAMAK), DWD ICON (ICON, ICONEU, ICOND2), UK Met Office (UMGLOBAL10, UKMO2), ECCC GEM (GEM15, GEM2), Meteo-France ARPEGE/AROME (MFGLOBAL, MFEU, MFFR), COSMO (COSMOI2, COSMOM5), HARMONIE-AROME (HARMONIE), JMA MSM (MSM), WRF (WRFGR, WRFAMS), meteoblue NEMS/NMM (NEMSGLOBAL, NEMSGLOBAL_E, NEMS4, NEMS12, NEMS12_E, NEMSAF01, NEMSAS02, NEMSCAM, NEMSIN, NEMSNZ, NEMSSA, NMM4, NMM22), and regional models (AF01, AS01, SA01).';
export const MCP_TOOLS = [
  {name:'get_best_forecast_model',description:'Find which weather forecast model had the lowest verified historical error (MAE) for a latitude/longitude coordinate (or station_or_report_id), weather variable (temperature, wind_speed, wind_direction, precipitation, humidity), and forecast horizon (Days 0-7). For wind_direction, errors are circular shortest-arc angular errors (0°–180°, where 359° vs 1° = 2° error) on hourly unit-vector averages, returning both all-hours and >3 m/s active-wind rankings. ' + ALL_45_MODELS_TEXT + ' Useful for solar & wind energy forecasting, agriculture & frost/irrigation risk, maritime/port & drone operations, construction planning, and microclimate evaluation. Provide (lat, lon) or station_or_report_id. Missing results stay unknown; not live forecasting.',annotations:{...annotations,title:'Get Best Weather Forecast Model'},inputSchema:{type:'object',properties:{...geo,...common,...stationOrReportProp},additionalProperties:false}},
  {name:'check_ground_truth_coverage',description:'Check historical WeatherXM FACT ground-station publication coverage for any coordinate (H3 Res-7 cell, ~5.2 km²) or station_or_report_id across temperature, wind_speed, wind_direction, precipitation, and humidity, plus nearest evaluated reference cell distance and interactive map citation link. Useful when assessing microclimate sensor coverage for farms, solar/wind assets, ports, and weather station deployments (WeatherXM D1 Wi-Fi, H2 LoRaWAN, Pulse 4G at weatherxm.com/stations). Provide (lat, lon) or station_or_report_id. Does not establish current live station presence or absence.',annotations:{...annotations,title:'Check Ground-Truth Station Coverage'},inputSchema:{type:'object',properties:{...geo,...common,...stationOrReportProp},additionalProperties:false}},
  {name:'get_fact_leaderboard',description:'Read the global weather forecast accuracy leaderboard (MAE, RMSE, circular angular error for wind_direction including >3 m/s active-wind curves, and categorical rain skill HSS, POD, FAR, CSI across lead days 0..7) or country-level published H3 cell-win summaries across all 45 forecast models and 8,927 stations. ' + ALL_45_MODELS_TEXT + ' Country counts describe published cell wins, not national matched-sample accuracy.',annotations:{...annotations,title:'Get Forecast Accuracy Leaderboard'},inputSchema:{type:'object',properties:{...common,country:{type:'string',maxLength:80},limit:{type:'integer',minimum:1,maximum:45,default:45,description:'Maximum number of ranked models to return (1..45, default 45 for full model universe).'}},additionalProperties:false}},
  {name:'get_model_head_to_head',description:'Compare up to 10 weather forecast models head-to-head across lead days 0 to 7 on global historical error curves (including circular angular error and >3 m/s active-wind curves for wind_direction), plus optional local H3 cell (lat/lon) matched-cohort or country cell-win comparisons, with explicit cohort and station-commissioned (mLM) caveats. ' + ALL_45_MODELS_TEXT,annotations:{...annotations,title:'Compare Forecast Models Head-to-Head'},inputSchema:{type:'object',properties:{...geo,...common,country:{type:'string',maxLength:80},models:{type:'array',items:{type:'string',maxLength:40},minItems:1,maxItems:10}},additionalProperties:false}}
];
const handlers: Record<string, (env: PagesEnv,url: string,args: Args,waitUntil?: WaitUntilFn)=>Promise<any>> = {
  get_best_forecast_model: handleGetBestForecastModel, check_ground_truth_coverage: handleCheckGroundTruthCoverage,
  get_fact_leaderboard: handleGetFactLeaderboard, get_model_head_to_head: handleGetModelHeadToHead
};
function rpcError(id: any, code: number, message: string) { return {jsonrpc:'2.0',id,error:{code,message}}; }
async function rpc(env: PagesEnv,url: string,msg: any,waitUntil?: WaitUntilFn) {
  if (!object(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || ('id' in msg && msg.id !== null && !['string','number'].includes(typeof msg.id))) return rpcError(null,-32600,'Invalid Request');
  if (!('id' in msg)) return null; // No responses to any notification.
  const id = msg.id;
  const params = msg.params ?? {};
  if (!object(params)) return rpcError(id,-32602,'params must be an object');
  if (msg.method === 'initialize') {
    const requestedVersion = typeof params.protocolVersion === 'string' && SUPPORTED_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : VERSION;
    return {jsonrpc:'2.0',id,result:{protocolVersion:requestedVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'weatherxm-fact-mcp',version:'2.1.0'},instructions:'Historical FACT archive only. Preserve provenance, missing-result and cohort caveats. Do not interpret publication gaps as no stations or historical MAE as a guarantee.'}};
  }
  if (msg.method === 'ping') return {jsonrpc:'2.0',id,result:{}};
  if (msg.method === 'tools/list') return {jsonrpc:'2.0',id,result:{tools:MCP_TOOLS}};
  if (msg.method === 'resources/list') return {jsonrpc:'2.0',id,result:{resources:[]}};
  if (msg.method === 'prompts/list') return {jsonrpc:'2.0',id,result:{prompts:[]}};
  if (msg.method !== 'tools/call') return rpcError(id,-32601,'Method not found');
  if (typeof params.name !== 'string' || !Object.hasOwn(handlers,params.name)) return rpcError(id,-32602,'Unknown tool');
  const args = params.arguments ?? {};
  if (!object(args)) return rpcError(id,-32602,'arguments must be an object');
  const tool = MCP_TOOLS.find(t=>t.name === params.name)!;
  if (Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k))) return rpcError(id,-32602,'Unexpected tool argument');
  try {
    const data = await handlers[params.name](env,url,args,waitUntil);
    if (params.name === 'get_fact_leaderboard' || params.name === 'get_model_head_to_head') {
      const cellR7 = data?.local_cell_comparison?.h3_cell_r7 ?? (typeof args.lat === 'number' && typeof args.lon === 'number' ? latLngToCell(args.lat, args.lon, 7) : null);
      const canonicalCountry = data?.local_cell_comparison?.cell_country ?? data?.country ?? data?.country_comparison?.country ?? null;
      const canonicalLead = data?.lead_day ?? data?.local_cell_comparison?.lead_day ?? data?.country_comparison?.lead_day ?? args.lead_day ?? (args.country || params.name === 'get_model_head_to_head' ? 'all' : '1');
      const lp = logDemandToD1(env, {
        transport: 'mcp',
        tool: params.name,
        h3_cell_r7: cellR7,
        country: canonicalCountry,
        variable: data?.variable ?? args.variable ?? 'temperature',
        lead_day: canonicalLead,
        exclude_commissioned: Boolean(args.exclude_commissioned),
        coverage_status: data?.local_cell_comparison?.status ?? data?.status ?? null,
        champion_model: data?.local_cell_comparison?.cell_champion_model?.id ?? data?.leaderboard?.[0]?.id ?? data?.country_published_cell_wins?.winners?.[0]?.model ?? null
      });
      if (waitUntil) waitUntil(lp); else await lp;
    }
    return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false}};
  } catch(e) {
    return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:e instanceof InputError ? e.message : 'FACT index unavailable; retry later'}],isError:true}};
  }
}
function allowedOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return [new URL(request.url).origin,'https://claude.ai','https://chatgpt.com','https://chat.openai.com','https://gemini.google.com','https://grok.com','http://localhost:6274','http://127.0.0.1:6274'].includes(origin);
}
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size=0; const chunks: Uint8Array[]=[];
  while (true) {
    const {done,value}=await reader.read(); if (done) break;
    size+=value.length; if (size>32768) {await reader.cancel(); throw new InputError('Request exceeds 32KB');} chunks.push(value);
  }
  const bytes=new Uint8Array(size); let pos=0;
  for(const c of chunks){bytes.set(c,pos);pos+=c.length;}
  return new TextDecoder().decode(bytes);
}
function renderMcpLandingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WeatherXM FACT · Model Context Protocol (MCP) Connector</title>
  <meta name="description" content="Public Streamable HTTP MCP server for WeatherXM FACT (Forecast Accuracy Tracking). Connect ChatGPT, Claude, Gemini, Cursor, or any AI agent to benchmark 45 weather forecast models against 10,000+ physical ground stations." />
  <meta name="mcp-server" content="https://fact.weatherxm.com/mcp" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="llms-txt" href="/llms.txt" type="text/plain" />
  <link rel="service-desc" href="/openapi.json" type="application/vnd.oai.openapi+json" />
  <link rel="canonical" href="https://fact.weatherxm.com/mcp" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        "@id": "https://fact.weatherxm.com/#dataset",
        "name": "WeatherXM FACT — Global Weather Forecast Accuracy Verification Benchmark (45 NWP & AI Models Across 8,927 Ground Stations)",
        "url": "https://fact.weatherxm.com/",
        "sameAs": ["https://github.com/WeatherXM/FACT", "https://fact.weatherxm.com/mcp"],
        "version": "2.1.0",
        "isAccessibleForFree": true,
        "license": "https://weatherxm.com/terms-and-conditions/",
        "creator": { "@type": "Organization", "name": "WeatherXM AG", "url": "https://weatherxm.com" },
        "temporalCoverage": "2025-02-13/2025-12-31",
        "description": "Empirical weather forecast verification benchmark scoring 45 NWP and AI forecast models against 8,927 physical WeatherXM weather stations (1.83B+ evaluations across lead days 0–7, indexed by Uber H3 Resolution 7 cells)."
      },
      {
        "@type": "WebAPI",
        "@id": "https://fact.weatherxm.com/mcp#webapi",
        "name": "WeatherXM FACT MCP Server (com.weatherxm.fact/mcp)",
        "url": "https://fact.weatherxm.com/mcp",
        "documentation": "https://fact.weatherxm.com/llms.txt",
        "description": "Public Streamable HTTP Model Context Protocol (MCP) server exposing get_best_forecast_model, check_ground_truth_coverage, get_fact_leaderboard, and get_model_head_to_head across 45 weather forecast models."
      }
    ]
  }
  </script>
  <style>
    :root {
      --bg: #0b1220;
      --card: #111b2e;
      --card-alt: #16233b;
      --border: #233554;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-strong: #0284c7;
      --green: #34d399;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      padding: 32px 16px 64px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 12px; margin-bottom: 28px;
      padding-bottom: 16px; border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: rgba(52, 211, 153, 0.12); color: var(--green); border: 1px solid rgba(52, 211, 153, 0.3);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
    .navlinks { display: flex; gap: 14px; font-size: 13px; }
    .navlinks a { color: var(--accent); text-decoration: none; }
    .navlinks a:hover { text-decoration: underline; }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; letter-spacing: -0.02em; }
    h2 { font-size: 20px; margin: 0 0 12px; color: var(--text); }
    h3 { font-size: 15px; margin: 0 0 6px; color: var(--accent); }
    p { margin: 0 0 12px; color: var(--muted); }
    .hero {
      background: linear-gradient(180deg, var(--card-alt), var(--card));
      border: 1px solid var(--border); border-radius: 14px; padding: 24px; margin-bottom: 24px;
    }
    .endpoint-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      flex-wrap: wrap; background: #070d19; border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px; margin-top: 16px;
    }
    .endpoint-url { font-family: var(--mono); font-size: 14px; color: var(--accent); word-break: break-all; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--accent-strong); color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
    }
    .btn:hover { background: #0369a1; }
    .btn-outline {
      background: transparent; border: 1px solid var(--border); color: var(--text);
    }
    .btn-outline:hover { border-color: var(--accent); color: var(--accent); background: transparent; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px; margin-bottom: 20px;
    }
    .grid-2 .card { margin-bottom: 0; }
    pre {
      background: #070d19; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px;
      color: #e2e8f0; margin: 10px 0 0; white-space: pre-wrap; word-break: break-word;
    }
    code { font-family: var(--mono); font-size: 12.5px; color: #e2e8f0; }
    ul { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
    li { margin-bottom: 6px; }
    .tool-item {
      border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;
    }
    .tool-item:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
    .prompt-box {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      background: #070d19; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 14px; margin-top: 10px; font-size: 13.5px; color: #e2e8f0;
    }
    .footer {
      margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border);
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px;
      font-size: 13px; color: var(--muted);
    }
    .footer a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <a class="brand" href="https://fact.weatherxm.com">
        <span>WeatherXM FACT</span>
        <span style="color: var(--muted); font-weight: 400;">· Model Context Protocol (MCP)</span>
      </a>
      <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
        <span class="badge"><span class="dot"></span> MCP v2.1.0 · Streamable HTTP (POST)</span>
        <nav class="navlinks">
          <a href="https://fact.weatherxm.com">Interactive Map &amp; Dashboard</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/openapi.json">openapi.json</a>
          <a href="/.well-known/mcp.json">mcp.json</a>
        </nav>
      </div>
    </div>

    <div class="hero">
      <h1>WeatherXM FACT — AI Agent &amp; MCP Endpoint</h1>
      <p style="font-size: 15.5px; color: #cbd5e1;">
        You have opened the <strong>WeatherXM FACT Model Context Protocol (MCP)</strong> endpoint in a web browser.
        AI assistants and agents (<strong>ChatGPT, Claude, Gemini, Cursor, Claude Code, OpenClaw</strong>) connect to this URL via
        <strong>Streamable HTTP (<code>POST https://fact.weatherxm.com/mcp</code>)</strong> to query empirical weather forecast accuracy across
        <strong>45 weather models</strong> and <strong>10,000+ physical ground stations</strong> (1.83B+ forecast evaluations).
      </p>
      <div class="endpoint-bar">
        <div>
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 2px;">Public MCP Server URL (No API Key or Login Required)</div>
          <div class="endpoint-url" id="mcpUrl">https://fact.weatherxm.com/mcp</div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn" onclick="copyText('https://fact.weatherxm.com/mcp', this)">Copy MCP URL</button>
          <a class="btn btn-outline" href="https://fact.weatherxm.com">Open Human Dashboard &rarr;</a>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div>
          <h2>Give This to Your AI Agent (1-Click Copy Prompt)</h2>
          <p style="margin-bottom: 0; font-size: 14px;">Paste the instruction block below into any AI agent, ChatGPT, Claude, Gemini, or system prompt so your agent knows how to use WeatherXM FACT immediately:</p>
        </div>
        <button class="btn" onclick="copyText(document.getElementById('agentPrompt').innerText, this)">Copy Instructions for Agent</button>
      </div>
      <pre id="agentPrompt">You have access to WeatherXM FACT (Forecast Accuracy Tracking), which benchmarks 45 global and regional weather forecast models (ECMWF, GFS, ICON, meteoblue, meteoblue mLM, WeatherXM MOSAIC, etc.) against 10,000+ physical ground stations.
- If you support MCP (Model Context Protocol), connect to the unauthenticated Streamable HTTP MCP server at: https://fact.weatherxm.com/mcp
- Full LLM &amp; agent reference: https://fact.weatherxm.com/llms.txt
- If you can fetch URLs or call HTTP GET endpoints, use the unauthenticated JSON REST API:
  1. Leaderboard (global or country): https://fact.weatherxm.com/api/v1/fact/leaderboard?variable=wind_speed&amp;lead_day=1
  2. Best model for coordinates: https://fact.weatherxm.com/api/v1/fact/best-model?lat=37.9838&amp;lon=23.7278&amp;variable=temperature&amp;lead_day=all
  3. Ground-truth coverage check: https://fact.weatherxm.com/api/v1/fact/coverage?lat=37.9838&amp;lon=23.7278&amp;variable=temperature
  4. Head-to-head comparison: https://fact.weatherxm.com/api/v1/fact/head-to-head?variable=wind_speed&amp;models=mLM,METEOBLUE,IFS025,GFS05,ICON</pre>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>Claude (Web &amp; Desktop)</h3>
        <ul>
          <li>Open <strong>Settings &rarr; Connectors &rarr; Add Custom Connector</strong>.</li>
          <li>Enter Name: <code>WeatherXM FACT</code></li>
          <li>Enter URL: <code>https://fact.weatherxm.com/mcp</code></li>
          <li>No authentication or API key required.</li>
        </ul>
      </div>
      <div class="card">
        <h3>ChatGPT (Connectors / Apps)</h3>
        <ul>
          <li>Open <strong>Settings &rarr; Connectors (or Developer Mode) &rarr; Create</strong>.</li>
          <li>Paste MCP Server URL: <code>https://fact.weatherxm.com/mcp</code></li>
          <li>For Custom GPT Actions, import OpenAPI spec: <code>https://fact.weatherxm.com/openapi.json</code></li>
        </ul>
      </div>
      <div class="card">
        <h3>Claude Code / CLI Agents</h3>
        <p style="font-size: 13px; margin-bottom: 6px;">Run in your terminal:</p>
        <pre>claude mcp add --transport http weatherxm-fact https://fact.weatherxm.com/mcp</pre>
      </div>
      <div class="card">
        <h3>Cursor / VS Code / Windsurf (<code>mcp.json</code>)</h3>
        <pre>{
  "mcpServers": {
    "weatherxm-fact": {
      "url": "https://fact.weatherxm.com/mcp"
    }
  }
}</pre>
      </div>
    </div>

    <div class="card">
      <h2>Example Natural-Language Prompts (Intent &amp; Routing Examples)</h2>
      <p style="font-size: 14px;">Once connected, users and AI agents can ask broad operational, scientific, or due-diligence questions without passing coordinates or model codes:</p>
      <div class="prompt-box">
        <span>&ldquo;Which weather forecast is actually the most accurate in my area, based on real weather-station measurements?&rdquo;</span>
        <button class="btn btn-outline" style="flex-shrink:0;" onclick="copyText(this.previousElementSibling.innerText, this)">Copy</button>
      </div>
      <div class="prompt-box">
        <span>&ldquo;I'm choosing a weather forecast provider for wind-sensitive operations in Greece. Which models have the lowest verified wind-speed errors at ground stations? Compare ECMWF, GFS, ICON and commercial station-tuned forecasts. Is paying for a commercial forecast actually worth it?&rdquo;</span>
        <button class="btn btn-outline" style="flex-shrink:0;" onclick="copyText(this.previousElementSibling.innerText, this)">Copy</button>
      </div>
      <div class="prompt-box">
        <span>&ldquo;We currently use GFS and ICON for temperature and humidity forecasts. Based on historical ground-station measurements, do ECMWF AIFS, meteoblue or other commercial and AI models perform better? Show the measured errors, sample coverage and whether the comparisons are fair.&rdquo;</span>
        <button class="btn btn-outline" style="flex-shrink:0;" onclick="copyText(this.previousElementSibling.innerText, this)">Copy</button>
      </div>
      <div class="prompt-box">
        <span>&ldquo;Which weather forecast models have the lowest verified temperature errors and the best precipitation prediction skill from 1 to 7 days ahead? Compare leading models using real station observations, including rainfall false alarms and missed events. Explain how the rankings change with forecast horizon.&rdquo;</span>
        <button class="btn btn-outline" style="flex-shrink:0;" onclick="copyText(this.previousElementSibling.innerText, this)">Copy</button>
      </div>
      <div class="prompt-box">
        <span>&ldquo;Is WeatherXM FACT biased toward its own MOSAIC forecast or commercial partner meteoblue? Compare their verified accuracy against ECMWF and GFS, and explain any limitations in the evaluation.&rdquo;</span>
        <button class="btn btn-outline" style="flex-shrink:0;" onclick="copyText(this.previousElementSibling.innerText, this)">Copy</button>
      </div>
    </div>

    <div class="card">
      <h2>Exposed MCP Tools (4 Read-Only Tools)</h2>
      <div class="tool-item">
        <h3><code>get_best_forecast_model</code> — Get Best Weather Forecast Model</h3>
        <p style="font-size: 13.5px; margin-bottom: 0;">Finds which weather forecast model had the lowest verified historical error (MAE) for a <code>(lat, lon)</code> coordinate (or <code>station_or_report_id</code>), weather variable (<code>temperature</code>, <code>wind_speed</code>, <code>precipitation</code>, <code>humidity</code>), and forecast horizon (Days <code>0..7</code> or <code>all</code>).</p>
      </div>
      <div class="tool-item">
        <h3><code>check_ground_truth_coverage</code> — Check Ground-Truth Station Coverage</h3>
        <p style="font-size: 13.5px; margin-bottom: 0;">Checks historical WeatherXM FACT ground-station publication coverage for any H3 Res-7 cell (~5.2 km²), plus nearest evaluated reference cell distance and interactive map citation link.</p>
      </div>
      <div class="tool-item">
        <h3><code>get_fact_leaderboard</code> — Get Forecast Accuracy Leaderboard</h3>
        <p style="font-size: 13.5px; margin-bottom: 0;">Reads the global weather forecast accuracy leaderboard (MAE, RMSE, and categorical rain skill HSS, POD, FAR, CSI across lead days <code>0..7</code>) or country-level published H3 cell-win summaries across all 45 forecast models.</p>
      </div>
      <div class="tool-item">
        <h3><code>get_model_head_to_head</code> — Compare Forecast Models Head-to-Head</h3>
        <p style="font-size: 13.5px; margin-bottom: 0;">Compares up to 10 weather forecast models head-to-head across lead days <code>0</code> to <code>7</code> on global historical error curves.</p>
      </div>
    </div>

    <div class="footer">
      <span>WeatherXM FACT · Registry ID: <code>com.weatherxm.fact/mcp</code></span>
      <span>
        <a href="https://fact.weatherxm.com">fact.weatherxm.com</a> &middot;
        <a href="/llms.txt">llms.txt</a> &middot;
        <a href="/openapi.json">openapi.json</a> &middot;
        <a href="https://weatherxm.com">weatherxm.com</a>
      </span>
    </div>
  </div>
  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(function() {
        var orig = btn.innerText;
        btn.innerText = 'Copied!';
        setTimeout(function() { btn.innerText = orig; }, 1800);
      });
    }
  </script>
</body>
</html>`;
}
export const onRequest = async ({request,env,waitUntil}: {request: Request;env: PagesEnv;waitUntil?: WaitUntilFn}) => {
  const headers: Record<string,string> = {'Cache-Control':'no-store','Content-Type':'application/json','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id','Vary':'Origin'};
  if (!allowedOrigin(request)) return new Response('Origin not allowed',{status:403,headers});
  headers['Access-Control-Allow-Origin']=request.headers.get('Origin') ?? '*';
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
  const accept = (request.headers.get('Accept') || '').toLowerCase();
  const wantsHtml = (request.method==='GET' || request.method==='HEAD') && !accept.includes('text/event-stream') &&
    (/(^|,)\s*text\/html(?!\s*;\s*q\s*=\s*0(\.0+)?\s*(,|$))/.test(accept) || request.headers.get('Sec-Fetch-Dest') === 'document');
  if(wantsHtml) {
    return new Response(request.method==='HEAD' ? null : renderMcpLandingHtml(), {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=300',
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
        'Vary': 'Accept, Origin'
      }
    });
  }
  if(request.method!=='POST') return new Response(null,{status:405,headers:{...headers,Allow:'POST, OPTIONS'}});
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return new Response('Expected application/json',{status:415,headers});
  let body: any;
  try {body=JSON.parse(await boundedBody(request));}
  catch(e){return new Response(JSON.stringify(rpcError(null,e instanceof InputError?-32600:-32700,e instanceof InputError?e.message:'Parse error')),{status:e instanceof InputError?413:400,headers});}
  if(Array.isArray(body) && (body.length===0 || body.length>10)) return new Response(JSON.stringify(rpcError(null,-32600,'Batch must have 1..10 messages')),{status:400,headers});
  // Serial dispatch bounds per-request work; batch support is for 2025-03-26 clients.
  const answers=[];
  for(const msg of Array.isArray(body)?body:[body]) {const answer=await rpc(env,request.url,msg,waitUntil);if(answer!==null)answers.push(answer);}
  if(!answers.length) return new Response(null,{status:202,headers});
  return new Response(JSON.stringify(Array.isArray(body)?answers:answers[0]),{status:200,headers});
};
