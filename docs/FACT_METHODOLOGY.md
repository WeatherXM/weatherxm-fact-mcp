# How FACT scores forecasts

**FACT (Forecast Accuracy Tracking) · Methodology, version 1.1 (2025 archive)**

This document explains, step by step, how FACT turns archived weather forecasts and ground-station
measurements into the numbers shown on this site. It is written for meteorologists, data scientists
and anyone who wants to judge whether the comparison is fair. It also lists, without softening, the
things FACT does not do and the places where its numbers can mislead.

---

## Summary

- **The question FACT answers:** *if you had relied on forecast X for this exact place, how far off
  would you have been?* FACT scores the forecast **as it was delivered** for a location, against what
  a ground station at that location **measured**.
- **Truth:** WeatherXM ground stations, quality-checked day by day. Not a reanalysis, not a gridded
  analysis product, and, as far as we know, not data assimilated by the forecast centres being scored.
- **Forecasts:** operational runs archived at the time they were issued, for 45 models (global, regional,
  AI-based and post-processed). No hindcasts or re-runs.
- **Pairs:** hourly forecast–observation pairs, grouped into one score per station, model, model run,
  variable and target day.
- **Metrics:** mean absolute error (MAE) and root mean square error (RMSE) for continuous variables,
  angular error for wind direction, and a rain/no-rain contingency table for daily precipitation.
- **Aggregation:** every average is weighted by the number of hourly pairs behind it. RMSE values are
  combined through their squares, never averaged directly.
- **Design goal:** operational usefulness at the user's location. FACT is not a test of how well a
  model represents the atmosphere as a whole, and it does not try to be one.

---

## 1. What FACT is designed to measure

Most forecast benchmarks in the research community ask a scientific question: *how well does this model
predict the state of the atmosphere?* They regrid every model to a common grid, verify against a
reanalysis or analysis, weight results by area so the whole globe counts, cover upper-air fields as well
as surface weather, and freeze a test period so results are reproducible. That design is the right one for
comparing models as models, and FACT does not replace it.

FACT asks a different question, the one a farmer, an energy trader, a logistics planner or a site
operator asks: **"Which forecast should I trust here, for this variable, this many days ahead?"**
Every design choice follows from that question:

| Design choice | Research benchmark (typical) | FACT | Why FACT does it this way |
|---|---|---|---|
| What is scored | Raw model fields on a common grid | The time series delivered for the user's location | That is the product a user actually receives |
| Ground truth | Reanalysis or analysis fields | Independent ground stations | Users experience the weather at a point, not a grid-box average |
| Representativeness error | Usually removed or treated separately | Counted as forecast error | A user is misled by it all the same |
| Spatial weighting | By area (every km² counts equally) | By where stations, and so users, are | Utility is concentrated where people operate |
| Variables | Surface and upper-air | Near-surface weather people act on | Temperature, humidity, wind, rain drive decisions |
| Forecast source | Re-runs or archived research output | Operational forecasts, archived as issued | No look-ahead, no retuning after the fact |
| Granularity of results | Global or regional scores | Down to a ~5 km² cell and a single station | "Best on average" is not "best here" |

The result is a benchmark of **forecast delivery at the last mile**: the combined effect of the
model, its resolution, the post-processing and interpolation applied before delivery, and the local
terrain and microclimate. A model that is excellent globally can still be the wrong choice in a
particular valley, and FACT is built to show that.

---

## 2. Data

### 2.1 Forecasts

- **Archive window:** 13 February 2025 to 31 December 2025 (322 days).
- **Models:** 45 forecast sources, including global NWP (ECMWF IFS, NOAA GFS, DWD ICON, UK Met
  Office UM, ECCC GEM, Météo-France), ECMWF's AI model AIFS, high-resolution regional models (for example
  HRRR, NAM, ICON-D2, ICON-EU, AROME/HARMONIE family, WRF configurations), and post-processed products
  (meteoblue, meteoblue mLM, WeatherXM MOSAIC).
- **Delivery channel:** third-party model output is obtained through a commercial multi-model forecast
  API (meteoblue) for the location of each WeatherXM station cell. FACT scores these time series as
  delivered. It does not regrid, bias-correct or height-correct them itself.
- **Operational, not retrospective:** every run is stored as it was received. Rows marked as historical
  or analysis values are excluded; only forward-looking forecast values are scored. Nothing is re-run
  after the outcome is known.
- **Every run counts separately:** each model run (initialization time) is evaluated as its own forecast.
  Forecasts are tracked up to 7 days ahead, limited by each model's own horizon as delivered (for example,
  ECMWF IFS stops at day 5 in this archive).

### 2.2 Observations

- **Stations:** WeatherXM ground stations, deployed by a community of hosts. 9,570 stations
  contributed to the raw 2025 archive; 8,927 remain after the quality gate described in Section 4.
- **Raw data:** sub-hourly measurements of temperature, relative humidity, pressure, wind speed and
  direction, and a cumulative rain counter.
- **Location grouping:** each station belongs to an H3 hexagonal cell at resolution 7 (average area about
  5.2 km², edge about 1.4 km). Forecasts are retrieved per cell; several stations in the same cell are
  scored against the same forecast.

Raw measurements are turned into hourly values that match what the forecast represents:

| Variable | How the hourly observation is built | Compared with |
|---|---|---|
| Temperature (°C) | 1-minute mean nearest to the top of the hour, within ±10 minutes | 2 m temperature at that hour |
| Relative humidity (%) | Same as temperature | 2 m relative humidity at that hour |
| Wind speed (m/s) | Vector average of the hour's measurements, then scaled from sensor height to 10 m with a fixed factor (×1.35) | 10 m wind speed |
| Wind direction (°) | Vector average of the hour; also a second series using only measurements above 3 m/s | 10 m wind direction |
| Precipitation (mm) | Hourly difference of the cumulative rain counter, negative glitches set to zero | Hourly precipitation |
| Daily precipitation (mm) | Difference of the rain counter across the UTC day | Sum of 24 hourly forecast values |
| Pressure (hPa) | Station pressure reduced to mean sea level using the station's altitude and temperature | Mean sea-level pressure |

All timestamps are UTC.

### 2.3 Pairing a forecast with an observation

For each station and each target day, FACT retrieves every run of every model issued in the previous
7 days that covers that day, for the station's cell. Forecast and observation are joined on the valid
hour, so each pair compares a forecast value with the measurement for the same hour at the same place.
A model that is missing for an hour simply produces no pair for that hour; nothing is filled in.

---

## 3. Scoring

### 3.1 Station-day scores

For one station *s*, one model *m*, one model run *r*, one variable *v* and one target day *d*, let
*f<sub>h</sub>* be the forecast and *o<sub>h</sub>* the observation at hour *h*, over the *n* hours of
that day where both exist (*n* ≤ 24):

- **MAE** = (1/*n*) Σ |*f<sub>h</sub>* − *o<sub>h</sub>*|
- **RMSE** = √[(1/*n*) Σ (*f<sub>h</sub>* − *o<sub>h</sub>*)²]
- **Wind direction** uses the smallest angle between forecast and observed direction
  (so 350° vs 10° is a 20° error, not 340°).

Each record keeps its sample count *n*, so it can be weighted correctly later. One record is one
model, one run, one variable, one station, one target day. The 2025 archive holds 1.83 billion of them.

### 3.2 Precipitation as an event

Millimetre errors reward models that forecast "dry" in places where it rarely rains. FACT therefore also
classifies each day as rain or no rain, using a 0.25 mm threshold on the daily total, and records a
2×2 contingency outcome per station-day and model: hit (*a*), false alarm (*b*), miss (*c*) or
correct negative (*d*). From these counts, the Heidke Skill Score is

HSS = 2(*ad* − *bc*) / [(*a* + *c*)(*c* + *d*) + (*a* + *b*)(*b* + *d*)]

where 1 is perfect, 0 is no better than chance and negative values are worse than chance. In this
release HSS drives model selection inside WeatherXM MOSAIC. The public views still show MAE and RMSE for
precipitation; event-based views are on the roadmap (Section 9).

### 3.3 Lead time

Lead time is measured from **when the model run started** (its initialization time, as reported by the
provider for each run), not from when WeatherXM collected or stored the forecast. This is the standard
convention in forecast verification. It ties every forecast to the atmospheric state it started from, so
all models are compared on the same clock, whatever their delivery schedule and however often we
collect them. WeatherXM MOSAIC follows the same rule: each MOSAIC forecast carries the initialization time
of the model runs it is built from.

**Lead day** = the number of calendar days (UTC) between a run's initialization date and the target day.
"Same day" (day 0) is the day the run started; "day 1" is the next calendar day, and so on. Section 8.4
covers what this definition does not capture.

---

## 4. Quality control

Low-cost community stations need stronger screening than synoptic stations. FACT applies three filters
before any average is computed:

1. **Quality of Data (QoD) gate.** Only station-days with a daily QoD score of at least 0.8 are scored.
   QoD is WeatherXM's own quality system, run every day on every station (summarised in Section 4.1).
2. **Minimum hourly support.** A station-day counts only if at least 18 of its 24 hours (75%) produced a
   valid pair for that model and variable.
3. **Gross-error screen.** Station-days whose daily MAE exceeds a physical plausibility limit
   (40 °C for temperature, 30 m/s for wind speed, 50 mm for precipitation, 100% for humidity) are
   discarded as data faults. These limits are deliberately loose: they catch broken records, not bad
   forecasts.

The same rules apply to every model. The QoD gate removes a station-day for all models at once; the
hourly-support and gross-error rules are applied to each model's record separately, so a model with
missing hours can drop out of a station-day that other models still count (see Section 8.5).

### 4.1 How WeatherXM's Quality of Data works

QoD is documented in full at
[docs.weatherxm.com](https://docs.weatherxm.com/weather-and-science/quality-mechanisms). In short, it
combines several independent mechanisms:

- **Out-of-Bounds Check (OBC).** Every raw reading is checked against the manufacturer's range for that
  station model and sensor (for example −40 to 60 °C for temperature on the WS1000). Rain is checked as
  the change in the accumulation counter per recording interval, so impossible rain rates are caught.
- **Self Quality Check (SQC).** Uses only the station's own data, with thresholds based on World
  Meteorological Organization and European Commission guidance, tuned on WeatherXM network data. It
  covers temperature, humidity, wind speed and direction, pressure and illuminance:
  - **Constancy:** a sensor stuck at one value for longer than is physically plausible (for example 4 hours
    for temperature, 6 hours for humidity and wind, 2 hours for pressure), with exceptions for fog and
    wet conditions, and a separate *frozen sensor* flag for wind at sub-zero temperatures. Anything
    constant for 24 hours is flagged regardless of conditions.
  - **Spikes and jumps:** changes too large to be physical, tested at the raw and minute scale (for
    example more than 2 °C between consecutive raw readings, or more than 3 °C between minute averages),
    with limits that scale with the sampling interval. The suspect value is identified by comparing both
    readings with a recent median.
  - **Missing data:** fewer data packets per hour than the station model should deliver.
  - These checks produce an hourly share of valid data for each of seven parameters. The daily OBC–SQC
    score is the average over 24 hours and over the seven parameters.
- **Indoors Station Detector (ISD).** Compares measured solar irradiance with the theoretical clear-sky
  value for that location, day and hour, together with the variability of temperature, humidity and
  wind. It detects stations that are indoors or almost indoors, badly or probably badly deployed, or
  mounted on an inclined pole (and in which direction). It is decided over a rolling 7-day window and
  lowers the station's daily quality score when it finds a problem.
- **Station Photo Verification (SPV).** Reviewers score four photos of each installation, one per compass
  direction, for obstacles affecting temperature and humidity, wind, rain and solar sensors, using WMO
  distance rules (for example, obstacles at least 7 times their height away for wind). It documents how
  well each station is sited.

The daily OBC–SQC and ISD results are combined into one daily quality score per station, and that is the
score FACT gates on.

---

## 5. Aggregation

### 5.1 Pooling rule

Any average over many station-days (a model's global curve, a cell's ranking, a station's history)
weights each station-day by its number of hourly pairs *n<sub>i</sub>*:

- **Pooled MAE** = Σ *n<sub>i</sub>* · MAE<sub>i</sub> / Σ *n<sub>i</sub>*
- **Pooled RMSE** = √[ Σ *n<sub>i</sub>* · RMSE<sub>i</sub>² / Σ *n<sub>i</sub>* ]

This is identical to computing MAE and RMSE directly over all underlying hourly pairs. Averaging RMSE
values directly would understate large errors, and FACT never does it.

### 5.2 What each view shows

- **Lead-time curves:** pooled MAE and RMSE per model and lead day across all station-days that pass
  the filters. A model-lead combination needs more than 50 station-days to be shown.
- **Network-wide vs regional models.** Regional models forecast only inside their domain. Their averages
  come from a different, smaller set of places and are not comparable with global models. Headline
  figures use network-wide models only: global models plus any model scored on at least 60% of the
  station-days of the best-covered model.
- **Cell champion:** within a cell and lead day, the model with the lowest pooled MAE. The **spread** is the
  gap between the best and worst model in that cell, a direct measure of how much the choice of forecast
  matters there.
- **Places shown:** a cell appears in the public views only where at least five models were scored. The
  public site shows a sample, the 2,500 cells with the most quality-checked stations per lead day, not
  the full network.

---

## 6. WeatherXM's own forecasts in the benchmark

WeatherXM runs FACT and also produces a forecast that appears in it. That is a conflict of interest, and
we treat it as one.

- **WeatherXM MOSAIC** is a synthetic forecast built from several third-party models. For each station
  and lead day it selects the model that performed best at that station over a trailing window of up to
  15 days, judged jointly on temperature RMSE, wind-direction RMSE and precipitation HSS; that model
  supplies all variables for that day. Different days can therefore come from different models, and
  where the choice changes MOSAIC blends the two models over the hours around midnight (23:00–01:00 UTC)
  to avoid jumps. It uses only verification results available before the forecast is issued, and it was
  archived operationally at issue time like every other model.
- **Meteoblue mLM** is a machine-learning, station-calibrated forecast commissioned for WeatherXM
  customers at about 50 stations. It is scored only at those stations (about 10,000 station-days per lead
  day, versus about 2.4 million for the main global models).

Both learn from the same stations that FACT later uses to score them. Selection in time is out of sample
(no future data is used), but in space it is in sample: they are tuned to exactly the places where they
are verified. They therefore show what a station-informed forecast achieves *at a station*, and they are
not a fair like-for-like comparison with raw NWP models that have never seen that station. For this
reason both are marked, can be switched off in every view, and are not used as the reference for any
third-party model's score.

---

## 7. Why we think the comparison is fair

- **Same truth, same filters, same pairs.** Every model is scored against the same station measurements,
  for the same hours, under the same quality rules.
- **Independent truth.** Verifying against a reanalysis tends to favour models initialized from the same
  analysis system. To our knowledge WeatherXM stations are not assimilated by the forecast centres scored
  here, so no model is graded against its own starting point.
- **No look-ahead.** Forecasts are stored as issued, not regenerated. Nothing in the evaluation can learn
  from the outcome it is graded on (WeatherXM's station-informed products aside, see Section 6).
- **No tuning to the benchmark.** Third-party output is not adjusted by FACT, so no model is helped or
  handicapped by our own corrections.
- **Scale.** Millions of station-days per model and lead day make the network-wide averages statistically
  stable, even though individual stations are noisy.
- **Transparency.** Sample counts are shown, regional and commissioned models are labelled, and this
  document lists the method's weaknesses.

---

## 8. Known limitations

These are the limitations we know of, roughly in order of how much they can affect a reader's conclusions.
For each one we state which way it is likely to bias results.

### 8.1 Point truth charges representativeness error to the forecast

A station measures one point; even a high-resolution model represents an area. Part of every error in FACT
is the difference between a point and that area (terrain, land use, a nearby building), not a failure of
the model. **Effect:** it favours high-resolution models and products that are downscaled or corrected to
the location, and penalises coarse global models in complex terrain. This is intended: a user is misled
by that difference all the same. It does mean FACT scores should not be read as a measure of a model's
skill at representing the atmosphere.

### 8.2 Station siting and sensors

WeatherXM stations are installed by hosts, so siting varies more than at a professional network. QoD
goes further than most community networks: ISD catches indoor, badly deployed and tilted stations, and
SPV reviews each installation against WMO distance rules. But a station can be outdoors, pass every
data check and still carry a steady bias, such as reading warm on sunny afternoons because of a nearby
wall, or reading low wind behind a building. ISD's own documentation notes that its criteria are
deliberately strict to avoid false alarms, so some poor deployments are not flagged. FACT does not yet
use SPV scores to filter or weight stations. **Effect:** adds error that no model can forecast, more for
wind (obstacles) and temperature (radiation) than for pressure. It inflates absolute errors for every
model, but it has much less effect on rankings, because all models face the same station. Single-station
cells are the most exposed; treat their local rankings with care.

### 8.3 How the quality gate interacts with the weather

QoD thresholds are set at physically implausible levels, and its constancy checks make exceptions for fog
and wet conditions, so ordinary bad weather is not what it removes. Three side effects remain:

- **Severe weather and real faults coincide.** Storms, icing and heavy rain also cause genuine sensor
  failures and data gaps, so the worst days are somewhat more likely to fall below the gate. **Effect:**
  extremes may be slightly under-represented. Averages here describe typical weather; they are not an
  evaluation of extremes.
- **The gate is per station-day, not per variable.** The daily score averages seven parameters, so a
  fault in one sensor (for example illuminance) can remove a day whose temperature was perfectly good,
  and a short fault in one variable can pass on a day that otherwise scores well.
- **Rain is only range-checked.** Precipitation goes through OBC but not SQC. A rain gauge that is
  blocked and reports zero, or under-catches in strong wind, is not caught by QoD. **Effect:** rain
  scores carry more station error than other variables, and a blocked gauge rewards models that forecast
  dry weather.

### 8.4 What the lead-day definition does not capture

Measuring lead time from the start of the model run is deliberate (Section 3.3), but two consequences
are worth stating:

- **Delivery delay is not part of the score.** A run reaches users some hours after it starts, and that
  delay differs between models. FACT does not penalise a model for arriving late, and "same day" includes
  hours that may already have passed by the time the forecast was usable. **Effect:** day-0 scores are
  slightly optimistic compared with what a user experiences. Delivery delay is a property of the supply
  chain rather than of forecast skill, so we would report it alongside the scores, not fold it into them.
- **Calendar-day bins.** A "day 1" forecast from a 00 UTC run is 24–47 hours ahead; from a 12 UTC run it is
  12–35 hours ahead. Models with different run schedules are therefore compared at slightly different
  effective lead times within the same bin.

Scoring in fixed lead-hour windows (for example 24–47 hours after run start) is planned.

### 8.5 Headline averages are not yet fully matched

Each model's curve is pooled over the station-days where that model was available. Availability differs:
about 2.4 million station-days per lead day for ECMWF IFS and NOAA GFS, about 2.0 million for ECMWF AIFS,
about 1.9 million for WeatherXM MOSAIC. If one model is missing more often on harder days or in harder
places, its average shifts for reasons unrelated to skill. The 60% coverage rule limits this but does not
remove it. Strict matched-sample comparisons (only station-days where every compared model is present)
are the correct method and are being added.

### 8.6 No uncertainty estimates yet

FACT does not yet publish confidence intervals or significance tests. Network-wide differences of a few
hundredths of a degree across millions of station-days are probably robust; a local "champion" in a cell
with one station and a few hundred days may not be. Errors are also correlated across nearby stations
and consecutive days, so naive sample counts overstate the real number of independent samples. Block
bootstrap intervals and paired tests between models are planned.

### 8.7 Weighting follows the network, not the globe

Every hourly pair counts equally, so regions with many stations dominate network-wide averages, and
regions with few stations barely register. **Effect:** a global ranking in FACT says "best where
WeatherXM stations are", not "best on Earth". This fits the end-user purpose, but it should not be read as
a global statement about any model.

### 8.8 Deterministic, near-surface, point scores only

FACT does not evaluate:

- **probabilistic or ensemble forecasts** (no CRPS, reliability or spread–skill);
  ensemble-based products, where present, are scored as a single deterministic series;
- **upper-air or large-scale fields**, or the spatial structure of a forecast (position of fronts, realistic
  small-scale detail, physical consistency between variables);
- **extremes** with dedicated scores (high thresholds, return periods);
- **skill relative to a baseline** such as climatology or persistence, which would make scores comparable
  across climates.

For precipitation, MAE is a weak headline because most hours are dry; event-based scores (Section 3.2)
are the better measure and will be shown.

### 8.9 Wind is the most station-dependent variable

Observed wind is scaled from sensor height to 10 m with one fixed factor, regardless of local surface
roughness or obstacles, and hourly speed is a vector average, which reads lower than the scalar mean
when direction varies within the hour. **Effect:** wind errors are dominated by siting and by these
conversions; they change little with lead time, which tells us they mostly measure the station rather
than the forecast. Use wind rankings with caution.

### 8.10 The delivered product, not the native model

Third-party models are scored as delivered through one commercial multi-model API, at that provider's
interpolation to the location. Models are also upgraded during the year, and the archive mixes those
versions. **Effect:** a score labelled with a model's name describes "that model as delivered to WeatherXM
in 2025", which is the right thing to measure for a buyer of forecasts, but it is not a definitive
statement about the originating centre's native output.

### 8.11 One partial year

The archive covers 13 February to 31 December 2025. Most of one winter month is missing, and one year
cannot show how stable rankings are from year to year or how models handle rare regimes.

### 8.12 Reproducibility

The station data and forecast archive are proprietary, and the evaluation pipeline is not yet public.
Readers cannot rerun the benchmark themselves today. We welcome scrutiny: researchers who want to audit
the pipeline or test it on a subset of the data can contact WeatherXM.

---

## 9. Roadmap

In rough priority order:

1. Matched-sample scoring for every head-to-head and headline comparison.
2. Confidence intervals (block bootstrap) and paired significance tests between models.
3. Lead time in fixed lead-hour windows from run start, and delivery delay reported per model.
4. Bias (mean error) alongside MAE and RMSE, to separate systematic offsets from random error.
5. Event-based precipitation views (hit rate, false-alarm ratio, CSI, HSS at several thresholds).
6. Skill scores against climatology and persistence baselines.
7. Per-region tables for regional models.
8. Per-cell quality flags for single-station outliers, and full-network coverage in the public views.
9. Probabilistic evaluation for ensemble products.

---

## 10. How to read FACT results

- **Use FACT to choose a forecast for a place.** It is designed for that, and it is strongest there.
- **Compare models within a view, not across views.** All models in one chart face the same stations and
  filters; numbers from different variables, lead days or regions do not.
- **Look at the sample size.** Network-wide curves rest on millions of station-days; a single cell may rest
  on a few hundred.
- **Treat WeatherXM MOSAIC and meteoblue mLM as station-informed products.** They show what local
  calibration achieves, not how a raw model compares.
- **Do not read FACT as a global model ranking.** For that, use benchmarks built for it: gridded,
  area-weighted, and verified against analyses. FACT complements those with the question they do not
  ask: what did the forecast mean for the person standing at that spot?

---

## Glossary

| Term | Meaning |
|---|---|
| Station-day | One station's hourly pairs for one model run, variable and UTC target day |
| MAE | Mean absolute error: average size of the miss, ignoring sign |
| RMSE | Root mean square error: like MAE but large misses weigh more |
| HSS | Heidke Skill Score: rain/no-rain accuracy relative to random chance |
| Lead day | Calendar days between a run's initialization date and the target day |
| H3 cell (res 7) | Hexagonal grid cell of about 5.2 km² used to group stations |
| QoD | Quality of Data: WeatherXM's daily per-station quality score (0–1), combining range, self-consistency and indoor/deployment checks |
| Network-wide model | Global model, or one scored on at least 60% of the best-covered model's station-days |
| Champion | Lowest pooled MAE among models scored in a cell, at a given lead day |
| Spread | Difference between the best and worst model's MAE in a cell |
