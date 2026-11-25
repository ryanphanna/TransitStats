"""
Daily Toronto weather (Open-Meteo archive, free, no key) into the lab database.

Only Toronto-area trips get weather: one city series would mislabel trips in other cities.
Join on trips.local_date where trips.tz = 'America/Toronto'.

Usage (from the repo root, after build_db.py):
    ml/.venv/bin/python ml/lab/fetch_weather.py
"""

import json
import os
import urllib.parse
import urllib.request
from datetime import date, timedelta

import duckdb
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "data", "transit.duckdb")
TORONTO = (43.65, -79.38)  # downtown; city-level, not any stop
DAILY = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "snowfall_sum", "rain_sum"]


def main():
    con = duckdb.connect(DB_PATH)
    first = con.execute("SELECT min(local_date) FROM trips WHERE tz = 'America/Toronto'").fetchone()[0]
    last = date.today() - timedelta(days=2)  # the archive lags a couple of days
    q = urllib.parse.urlencode({
        "latitude": TORONTO[0], "longitude": TORONTO[1],
        "start_date": first.isoformat(), "end_date": last.isoformat(),
        "daily": ",".join(DAILY), "timezone": "America/Toronto",
    })
    with urllib.request.urlopen(f"https://archive-api.open-meteo.com/v1/archive?{q}", timeout=60) as r:
        daily = json.load(r)["daily"]
    df = pd.DataFrame(daily).rename(columns={
        "time": "local_date", "temperature_2m_max": "temp_max_c", "temperature_2m_min": "temp_min_c",
        "precipitation_sum": "precip_mm", "snowfall_sum": "snow_cm", "rain_sum": "rain_mm",
    })
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    con.execute("CREATE OR REPLACE TABLE weather_toronto AS SELECT * FROM df")
    print(f"weather_toronto: {len(df)} days, {df.local_date.min()} to {df.local_date.max()}")


if __name__ == "__main__":
    main()
