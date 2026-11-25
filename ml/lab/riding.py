import marimo

__generated_with = "0.26.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import os

    import duckdb
    import marimo as mo
    import numpy as np
    import statsmodels.api as sm
    import statsmodels.formula.api as smf

    DB = os.path.join(os.path.dirname(__file__), "data", "transit.duckdb")
    con = duckdb.connect(DB, read_only=True)
    mo.md(
        """
        # Riding lab

        Questions about how the rider rides, on the lab database (`build_db.py`).
        Outputs stay local: marimo caches them in `__marimo__/`, which is gitignored.
        Record findings in Linear, not in the repo.
        """
    )
    return con, mo, np, sm, smf


@app.cell
def _(con, mo):
    _t = con.sql(
        "SELECT count(*) n, min(local_date) first, max(local_date) last FROM trips WHERE counted"
    ).df()
    mo.md(f"**{int(_t.n[0])} counted trips**, {_t['first'][0]} to {_t['last'][0]} (matches the app's total).")
    return


@app.cell
def _(mo):
    mo.md(
        """
        ## 1. Does weather change how much you ride?

        Toronto days only, excluding days with trips in another city. Negative binomial model of
        trips per day, with month and weekday fixed effects so seasons and schedule changes
        don't masquerade as weather.
        """
    )
    return


@app.cell
def _(con, np, sm, smf):
    daily = con.sql(
        """
        WITH away AS (SELECT DISTINCT local_date FROM trips WHERE counted AND tz <> 'America/Toronto'),
        cnt AS (SELECT local_date, count(*) n FROM trips WHERE counted AND tz = 'America/Toronto' GROUP BY 1)
        SELECT w.*, coalesce(cnt.n, 0) n, dayofweek(w.local_date) dow, strftime(w.local_date, '%Y-%m') ym
        FROM weather_toronto w LEFT JOIN cnt USING (local_date)
        WHERE w.local_date NOT IN (SELECT local_date FROM away)
        """
    ).df()
    daily["rain5"] = (daily.rain_mm >= 5).astype(int)
    daily["snow2"] = (daily.snow_cm >= 2).astype(int)
    daily["cold"] = (daily.temp_max_c < 0).astype(int)
    daily["hot"] = (daily.temp_max_c >= 28).astype(int)
    _m = smf.glm(
        "n ~ rain5 + snow2 + cold + hot + C(dow) + C(ym)",
        data=daily, family=sm.families.NegativeBinomial(alpha=0.3),
    ).fit()
    _ci = np.exp(_m.conf_int())
    weather_effects = [
        {"condition": k, "days": int(daily[k].sum()), "trips_multiplier": round(float(np.exp(_m.params[k])), 2),
         "ci_low": round(float(_ci.loc[k, 0]), 2), "ci_high": round(float(_ci.loc[k, 1]), 2),
         "p": round(float(_m.pvalues[k]), 3)}
        for k in ["rain5", "snow2", "cold", "hot"]
    ]
    weather_effects
    return


@app.cell
def _(mo):
    mo.md(
        """
        ## 2. How often do you break routine?

        A "new pair" is a start→end stop pair never ridden before; a "new end" is a destination
        never reached before. Stops are grouped the app's way (`stop_canon.py`). The graded slice
        (clean TTC texted trips) is what the prediction scoreboard grades, so the new-pair share
        there is roughly the ceiling for any model that only learns from your own history.
        """
    )
    return


@app.cell
def _(con):
    routine = con.sql(
        """
        WITH t AS (
            SELECT *,
                row_number() OVER (PARTITION BY end_stop ORDER BY start_utc) ke,
                row_number() OVER (PARTITION BY start_stop, end_stop ORDER BY start_utc) kp
            FROM trips WHERE counted AND start_stop IS NOT NULL AND end_stop IS NOT NULL
        )
        SELECT strftime(local_date, '%Y') || '-Q' || quarter(local_date) AS yq,
            clean AND agency = 'TTC' AND source IN ('sms', 'sms_fallback', 'mms') graded_slice,
            count(*) trips,
            round(avg((ke = 1)::int), 2) new_end_share,
            round(avg((kp = 1)::int), 2) new_pair_share
        FROM t GROUP BY ALL ORDER BY 1, 2
        """
    ).df()
    routine
    return


@app.cell
def _(mo):
    mo.md(
        """
        ## 3. When did your riding change?

        Weekly trip counts (all counted trips). Look for lasting level shifts, e.g. a move or a
        new schedule, rather than single busy weeks.
        """
    )
    return


@app.cell
def _(con, mo):
    import altair as alt

    weekly = con.sql(
        """
        SELECT date_trunc('week', local_date) AS week_start, count(*) trips
        FROM trips WHERE counted GROUP BY 1 ORDER BY 1
        """
    ).df()
    _base = alt.Chart(weekly).encode(x="week_start:T")
    _chart = _base.mark_line(opacity=0.35).encode(y="trips:Q") + _base.transform_window(
        avg="mean(trips)", frame=[-6, 6]
    ).mark_line().encode(y=alt.Y("avg:Q", title="trips per week (13-week average)"))
    mo.ui.altair_chart(_chart)
    return


if __name__ == "__main__":
    app.run()
