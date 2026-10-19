"""Blossom Watch phenology model.

Observed bloom index
    For each region × bloom group × year: the median day-of-year of iNaturalist observations
    (Jan–Jun) of that taxon, excluding records annotated as "no flowers". People photograph
    cherries when they are in bloom, so the observation peak tracks peak bloom.

Candidate models (all pooled across regions, so sparse regions borrow strength):
    clim  – climatology: mean observed day-of-year per region and group.
    gdd   – thermal time: bloom when Σ max(0, Tmean − Tb) from day t0 reaches F*.
    chill – as gdd, but F* falls exponentially with winter chill (days < 5 °C from 1 Nov),
            i.e. the "alternating" model of Cannell & Smith (1983).
Model choice per group is by leave-one-year-out cross-validated MAE.

Seasons are indexed in days since 1 September of the previous year with 29 February removed,
so 1 January = index 122 and every season has 303 days (to 30 June).
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np
import pandas as pd

from pipelines.common.eccc import splice

from .config import GROUPS, RAW, REGIONS

SEASON_DAYS = 303
JAN1 = 122
NOV1 = 61
CHILL_BASE = 5.0
TB_GRID = np.arange(0.0, 8.01, 0.5)
T0_GRID = [JAN1 - 61, JAN1 - 31, JAN1, JAN1 + 14, JAN1 + 31, JAN1 + 45, JAN1 + 59]   # Nov 1 … Mar 1
C_GRID = [-0.005, -0.01, -0.02, -0.03, -0.05]
ANALOG_YEARS = 30
MIN_OBS = 8


# ----------------------------------------------------------------------------- weather

def build_region_temps(weather: pd.DataFrame) -> dict[str, pd.Series]:
    """Splice each region's station chain into one daily mean-temperature series."""
    out = {}
    for rkey, reg in REGIONS.items():
        chain = []
        for sid in reg["stations"]:
            s = weather[weather.station == sid].set_index("date")
            chain.append(s.tmean.where(s.tmean.notna(), (s.tmax + s.tmin) / 2))
        out[rkey] = splice(chain).interpolate(limit=7, limit_area="inside")
    return out


def season_array(temps: pd.Series, year: int, until: date | None = None) -> tuple[np.ndarray, float]:
    """Season `year` (Sep 1 of year-1 to Jun 30 of year) as a 303-day array, Feb 29 removed.

    Returns (array, fraction_missing). Days after `until` are NaN.
    """
    idx = pd.date_range(f"{year - 1}-09-01", f"{year}-06-30", freq="D")
    idx = idx[~((idx.month == 2) & (idx.day == 29))]
    vals = temps.reindex(idx).to_numpy(dtype=float, copy=True)
    if until is not None:
        vals[idx.date > until] = np.nan
    return vals, float(np.isnan(vals).mean())


def idx_to_date(year: int, i: float) -> date:
    d = date(year - 1, 9, 1) + timedelta(days=int(round(i)))
    if (date(year, 3, 1) - date(year, 2, 28)).days == 2 and d >= date(year, 2, 29):
        d += timedelta(days=1)          # account for the removed Feb 29
    return d


def doy_to_idx(doy: float) -> float:
    return doy - 1 + JAN1


# ----------------------------------------------------------------------------- observations

def observed_bloom(inat: pd.DataFrame) -> pd.DataFrame:
    """Median observation day per region × group × year (non-leap day-of-year).

    Each group only counts observations inside its phenological window, which keeps
    winter-flowering cultivars and summer leaf/fruit photos out of the index.
    """
    df = inat.dropna(subset=["observed_on"]).copy()
    df = df[~df.flower_annotation.isin([14, 15, 21])]
    d = df.observed_on
    df["year"] = d.dt.year
    df["doy"] = d.dt.dayofyear - ((d.dt.is_leap_year) & (d.dt.month > 2)).astype(int)
    lo = df.group.map(lambda g: GROUPS[g]["obs_window"][0])
    hi = df.group.map(lambda g: GROUPS[g]["obs_window"][1])
    df = df[(df.doy >= lo) & (df.doy <= hi)]
    g = df.groupby(["region", "group", "year"]).doy
    obs = pd.DataFrame({"n": g.size(), "doy": g.median(), "q25": g.quantile(0.25), "q75": g.quantile(0.75)}).reset_index()
    return obs[obs.n >= MIN_OBS].reset_index(drop=True)


# ----------------------------------------------------------------------------- models

TSENS_WINDOWS = [(JAN1, JAN1 + 58), (JAN1, JAN1 + 89), (JAN1 + 31, JAN1 + 89), (JAN1 + 31, JAN1 + 104),
                 (JAN1 + 59, JAN1 + 104)]
F_QUANTILES = np.arange(0.30, 0.71, 0.05)


@dataclass
class Fitted:
    kind: str
    params: dict = field(default_factory=dict)
    clim: dict = field(default_factory=dict)        # region -> mean doy (clim) or offset (tsens)

    def predict_idx(self, arr: np.ndarray, region: str) -> float:
        p = self.params
        if self.kind == "clim":
            mean = self.clim.get(region, np.mean(list(self.clim.values())))
            return doy_to_idx(mean)
        if self.kind == "tsens":
            t = np.nanmean(arr[p["w0"]:p["w1"]])
            return doy_to_idx(p["a"] + p["b"] * t + self.clim.get(region, 0.0))
        f = np.maximum(0.0, arr - p["tb"])
        f[: p["t0"]] = 0.0
        cum = np.nancumsum(f)
        if self.kind == "chill":
            need = p["a"] + p["b"] * np.exp(p["c"] * _chill_curve(arr))
        else:
            need = p["F"]
        hit = np.nonzero(cum >= need)[0]
        hit = hit[hit >= JAN1 - 30]
        return float(hit[0]) if len(hit) else np.nan


def _chill_curve(arr: np.ndarray) -> np.ndarray:
    c = (arr < CHILL_BASE).astype(float)
    c[:NOV1] = 0.0
    return np.cumsum(c)


def _forcing_at(arr: np.ndarray, tb: float, t0: int, i: int) -> float:
    f = np.maximum(0.0, arr[: i + 1] - tb)
    f[:t0] = 0.0
    return float(np.nansum(f))


def _score(m: Fitted, rows) -> float:
    pred = np.array([m.predict_idx(a, r) for r, a, _ in rows])
    err = pred - np.array([i for _, _, i in rows])
    return float(np.sqrt(np.nanmean(err ** 2)) + 50 * np.isnan(pred).mean())


def fit(kind: str, rows: list[tuple[str, np.ndarray, float]], fixed: dict | None = None) -> Fitted:
    """rows: (region, season array, observed index).

    kind: clim | gdd | chill | tsens | borrowed (gdd with tb/t0 taken from `fixed`).
    """
    if kind == "clim":
        df = pd.DataFrame([(r, i - JAN1 + 1) for r, _, i in rows], columns=["r", "doy"])
        return Fitted("clim", clim=df.groupby("r").doy.mean().to_dict())

    if kind == "tsens":
        best = (np.inf, None)
        obs_doy = np.array([i - JAN1 + 1 for _, _, i in rows])
        regions = np.array([r for r, _, _ in rows])
        for w0, w1 in TSENS_WINDOWS:
            if w1 > np.median([i for _, _, i in rows]):
                continue
            t = np.array([np.nanmean(a[w0:w1]) for _, a, _ in rows])
            off = {r: 0.0 for r in set(regions)}
            for _ in range(5):                       # alternate slope and shrunken region offsets
                y = obs_doy - np.array([off[r] for r in regions])
                b, a = np.polyfit(t, y, 1)
                resid = obs_doy - (a + b * t)
                off = {r: float(resid[regions == r].sum() / ((regions == r).sum() + 2)) for r in set(regions)}
            m = Fitted("tsens", {"w0": w0, "w1": w1, "a": float(a), "b": float(b)}, clim=off)
            sc = _score(m, rows)
            if sc < best[0]:
                best = (sc, m)
        return best[1]

    best = (np.inf, None)
    grid = [(fixed["tb"], fixed["t0"])] if kind == "borrowed" else itertools.product(TB_GRID, T0_GRID)
    for tb, t0 in grid:
        if any(int(i) <= t0 for _, _, i in rows):
            continue
        F_obs = np.array([_forcing_at(a, tb, t0, int(i)) for _, a, i in rows])
        if kind in ("gdd", "borrowed"):
            cands = [{"tb": tb, "t0": t0, "F": float(np.quantile(F_obs, q))} for q in F_QUANTILES]
        else:
            chill = np.array([_chill_curve(a)[int(i)] for _, a, i in rows])
            cands = []
            for c in C_GRID:
                X = np.column_stack([np.ones_like(chill), np.exp(c * chill)])
                (a, b), *_ = np.linalg.lstsq(X, F_obs, rcond=None)
                if b < 0:
                    continue
                cands.append({"tb": tb, "t0": t0, "a": float(a), "b": float(b), "c": c})
        for p in cands:
            m = Fitted("gdd" if kind == "borrowed" else kind, p)
            sc = _score(m, rows)
            if sc < best[0]:
                best = (sc, m)
    return best[1]


def loyo_cv(kind: str, rows: list[tuple[str, int, np.ndarray, float]], fixed: dict | None = None) -> pd.DataFrame:
    """Leave-one-year-out CV. rows: (region, year, array, observed idx)."""
    out = []
    for y in sorted({r[1] for r in rows}):
        train = [(r, a, i) for r, yy, a, i in rows if yy != y]
        test = [(r, yy, a, i) for r, yy, a, i in rows if yy == y]
        if len({yy for _, yy, _, _ in rows if yy != y}) < 3:
            continue
        m = fit(kind, train, fixed)
        for r, yy, a, i in test:
            out.append({"region": r, "year": yy, "obs": i - JAN1 + 1, "pred": m.predict_idx(a, r) - JAN1 + 1})
    df = pd.DataFrame(out)
    df["err"] = df.pred - df.obs
    return df


# ----------------------------------------------------------------------------- forecasting

def analog_forecast(model: Fitted, temps: pd.Series, region: str, year: int, issue: date,
                    analog_years: list[int]) -> np.ndarray:
    """Observed temperatures up to `issue`, then each analog year's weather afterwards."""
    obs, _ = season_array(temps, year, until=issue)
    preds = []
    for ay in analog_years:
        a, miss = season_array(temps, ay)
        if miss > 0.05:
            continue
        mix = np.where(np.isnan(obs), a, obs)
        if np.isnan(mix).mean() > 0.05:
            continue
        mix = pd.Series(mix).interpolate(limit_direction="both").to_numpy()
        preds.append(model.predict_idx(mix, region))
    return np.array([p for p in preds if not np.isnan(p)])


def load_inputs():
    weather = pd.read_parquet(RAW / "weather.parquet")
    inat = pd.read_parquet(RAW / "inat.parquet")
    trees = pd.read_parquet(RAW / "trees.parquet")
    return weather, inat, trees


def modelled_groups():
    return [g for g, v in GROUPS.items() if "taxon_id" in v]
