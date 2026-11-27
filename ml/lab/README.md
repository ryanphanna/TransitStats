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

## Colab (V5 tuning)

`ml/colab/v5_tuning.ipynb` searches XGBoost settings for the V5 end-stop model on Google's machines
(free GPU), using `train_endstop.py`'s own cleaning, features and chronological split. Report only.

```
TRAIN_USER_IDS=<uid> GOOGLE_APPLICATION_CREDENTIALS=<key> ml/.venv/bin/python ml/export_trips.py
ml/colab/make_bundle.sh        # -> ml/lab/data/colab/ts-bundle.zip (holds trip data; gitignored)
```

Upload the zip to My Drive/TransitStats/, open
https://colab.research.google.com/github/ryanphanna/TransitStats/blob/main/ml/colab/v5_tuning.ipynb
and choose Runtime → Run all. Results land in the same Drive folder.

## Findings

Findings are personal, so they live in Linear (TransitStats project), not in this public repo.
