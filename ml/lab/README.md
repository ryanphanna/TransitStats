# Riding lab

Questions about how the rider rides, separate from the prediction pipeline. Data and results stay
on this Mac: `ml/lab/data/` and `ml/.venv/` are gitignored, and the notebook is a marimo `.py` file
whose output cache (`__marimo__/`) is gitignored. Anything written here is aggregates only (no stop names, trip IDs or
per-stop counts), the same rule as `ml/EVAL.md`.

## Setup and refresh

```
uv venv ml/.venv --python 3.13
uv pip install --python ml/.venv/bin/python -r ml/lab/requirements.txt
node ml/lab/export_all.mjs              # every ride, counted the app's way -> data/rides.jsonl, data/stops.json
ml/.venv/bin/python ml/lab/build_db.py  # -> data/transit.duckdb (table trips, stops)
ml/.venv/bin/python ml/lab/fetch_weather.py   # adds weather_toronto (Open-Meteo, city-level)
ml/.venv/bin/marimo edit ml/lab/riding.py
```

- `export_all.mjs` calls the app's own `countedRides()`, so `WHERE counted` matches the website
  and ASK totals exactly (checked 2026-11-24: 3,958, every year equal). It includes legacy history,
  incomplete trips and imported PRESTO taps; `ml/export_trips.py` (training) keeps only clean trips.
- Stops are grouped with `ml/stop_canon.py`, the app's rule. `clean` is the serving-history filter.
- Times are bucketed in each trip's own timezone (`local_date`, `local_hour`, `local_dow`).

## Findings

### 2026-11-24: weather barely changes how much you ride

Toronto days (n=918, trips in other cities excluded), negative binomial on trips per day with
month and weekday fixed effects. Raw averages suggest fewer trips on rainy weekdays and more on
cold days, but that is mostly season.

| Condition | Days | Trips × | 95% CI | p |
|---|---|---|---|---|
| Rain ≥5 mm | 120 | 0.94 | 0.80–1.10 | 0.43 |
| Snow ≥2 cm | 27 | 0.89 | 0.66–1.21 | 0.46 |
| High below 0 °C | 107 | 1.17 | 0.95–1.45 | 0.13 |
| High 28 °C+ | 51 | 1.29 | 1.01–1.64 | 0.04 |

Hot days are the only hint, and with four tests it would not survive a multiple-comparison
correction. Next: test whether weather changes *where* you go rather than how often.

### 2026-11-24: about 30% of graded trips are a never-ridden pair

On the graded slice (clean TTC texted trips), the share of trips whose start→end pair had never
been ridden before: Q2 50% (n=285), Q3 36% (n=179), Q4 so far 30% (n=135). Brand-new destinations:
21%, 8%, 6%. Early quarters are inflated because stop-level history only starts in 2026.

A model that learns only from the rider's own history can rarely get a never-ridden pair right, so
top-1 end-stop accuracy has a rough ceiling near 70% this quarter. The weekly shadow grades
(V4 70% on 2026-11-16) are already near it. Gains beyond that need signals other than
personal history (network, time of day, where similar trips go).
