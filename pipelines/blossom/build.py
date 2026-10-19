"""Fit, validate and forecast, then write the JSON the website reads.

  python -m pipelines.blossom.build [--today YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd

from .config import GROUPS, OUT, REGIONS
from .cultivars import CULTIVARS, TIER_BLURB
from .model import (JAN1, SEASON_DAYS, analog_forecast, build_region_temps, doy_to_idx, fit, idx_to_date,
                    load_inputs, loyo_cv, modelled_groups, observed_bloom, season_array, ANALOG_YEARS)

KINDS = ["clim", "gdd", "chill", "tsens"]
ISSUE_DATES = [(1, 1), (2, 1), (2, 15), (3, 1), (3, 15), (4, 1)]
TREE_CITIES = {"victoria": "victoria", "vancouver": "vancouver", "esquimalt": "victoria"}     # city -> forecast region
PHOTOS = Path(__file__).with_name("cultivar_photos.json")


def target_season(today: date) -> int:
    return today.year + 1 if today.month >= 7 else today.year


def dump(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=_default)
    print(f"  wrote {name} ({(OUT / name).stat().st_size / 1024:,.0f} KB)")


def _default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else round(float(o), 2)
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    raise TypeError(type(o))


def r1(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 1)


def main(today: date) -> None:
    weather, inat, trees = load_inputs()
    temps = build_region_temps(weather)
    obs = observed_bloom(inat[inat.group.isin(modelled_groups())])
    season = target_season(today)
    last_complete = season - 1 if today < date(season, 6, 30) else season
    print(f"Target season {season}; analog years {last_complete - ANALOG_YEARS + 1}–{last_complete}")

    # ---- training rows per group
    rows_by_group: dict[str, list] = {}
    for g in modelled_groups():
        rows = []
        for _, o in obs[obs.group == g].iterrows():
            arr, miss = season_array(temps[o.region], int(o.year))
            if miss > 0.03:
                continue
            arr = pd.Series(arr).interpolate(limit_direction="both").to_numpy()
            rows.append((o.region, int(o.year), arr, doy_to_idx(o.doy)))
        rows_by_group[g] = rows

    # ---- cross-validated model selection (donor groups first so borrowers can use them)
    models, card, chosen, fixed, residuals = {}, {}, {}, {}, {}
    order = sorted(rows_by_group, key=lambda g: "borrow_from" in GROUPS[g])
    for g in order:
        rows = rows_by_group[g]
        kinds = list(KINDS)
        donors = GROUPS[g].get("borrow_from") or []
        fixed_by_kind = {}
        for d in donors:
            dm = fit("gdd", [(r, a, i) for r, _, a, i in rows_by_group[d]])
            fixed_by_kind[f"borrowed:{d}"] = {"tb": dm.params["tb"], "t0": dm.params["t0"]}
            kinds.append(f"borrowed:{d}")
        scores, cv_frames = {}, {}
        for k in kinds:
            cv = loyo_cv(k.split(":")[0], rows, fixed_by_kind.get(k))
            cv_frames[k] = cv
            scores[k] = {"mae": r1(cv.err.abs().mean()), "rmse": r1(np.sqrt((cv.err ** 2).mean())),
                         "bias": r1(cv.err.mean()), "n": int(cv.err.notna().sum())}
        mae = lambda k: scores[k]["mae"] if scores[k]["mae"] is not None else 1e9
        # Borrowing groups keep a donor's temperature response (best donor by CV): their own index is
        # too noisy to identify one, so a static climatology would ignore the weather entirely.
        best = min([k for k in kinds if k.startswith("borrowed")] if donors else kinds, key=mae)
        donor = best.split(":")[1] if donors else None
        fixed[g] = fixed_by_kind.get(best)
        residuals[g] = cv_frames[best]
        m = fit(best.split(":")[0], [(r, a, i) for r, _, a, i in rows], fixed.get(g))
        models[g], chosen[g] = m, best
        skill = 1 - scores[best]["mae"] / scores["clim"]["mae"] if scores["clim"]["mae"] else None
        card[g] = {"chosen": best, "borrowed_from": donor, "scores": scores,
                   "skill_vs_clim": r1(skill * 100) if skill is not None else None,
                   "params": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in m.params.items()},
                   "region_terms": {k: round(v, 2) for k, v in m.clim.items()},
                   "n_obs": len(rows), "years": sorted({y for _, y, _, _ in rows}),
                   "cv": cv_frames[best].assign(pred=lambda d: d.pred.round(1)).to_dict("records")}
        print(f"  {g:<9} n={len(rows):>2}  " + "  ".join(f"{k}:{scores[k]['mae']}" for k in kinds) + f"  -> {best} {m.params}")

    def group_model(g):
        if "offset_from" in GROUPS[g]:
            base, off = GROUPS[g]["offset_from"]
            return models[base], off, base
        return models[g], 0, g

    def with_residuals(preds: np.ndarray, base: str, exclude_year: int | None = None) -> np.ndarray:
        """Predictive sample = analog-weather spread + the model's own cross-validated errors."""
        cv = residuals[base]
        err = cv[cv.year != exclude_year].err.dropna().to_numpy() if exclude_year else cv.err.dropna().to_numpy()
        return (preds[:, None] - err[None, :]).ravel() if len(err) else preds

    analogs = list(range(last_complete - ANALOG_YEARS + 1, last_complete + 1))

    # ---- forecasts for the target season
    forecast = {"season": season, "issued": today.isoformat(), "regions": {}}
    for rkey in REGIONS:
        t = temps[rkey]
        data_through = t.dropna().index.max().date()
        reg = {"data_through": data_through.isoformat(), "groups": {}}
        for g in GROUPS:
            m, off, base = group_model(g)
            preds = analog_forecast(m, t, rkey, season, min(today, data_through), analogs) + off
            if not len(preds):
                continue
            sample = with_residuals(preds, base)
            q = np.percentile(sample, [10, 25, 50, 75, 90])
            reg["groups"][g] = {
                "p10": idx_to_date(season, q[0]).isoformat(), "p25": idx_to_date(season, q[1]).isoformat(),
                "median": idx_to_date(season, q[2]).isoformat(), "p75": idx_to_date(season, q[3]).isoformat(),
                "p90": idx_to_date(season, q[4]).isoformat(),
                "q": [r1(v - JAN1 + 1) for v in np.percentile(sample, np.arange(2.5, 100, 5))],   # 20 quantiles
            }
        # forcing curve for the headline group (Japanese cherries) to draw the "race to bloom" chart
        m = models["japanese"]
        if m.kind in ("gdd", "chill"):
            tb, t0 = m.params["tb"], m.params["t0"]
            curves = {}
            for y in analogs + [season]:
                arr, miss = season_array(t, y, until=min(today, data_through) if y == season else None)
                if y != season and miss > 0.05:
                    continue
                f = np.maximum(0.0, arr - tb)
                f[:t0] = 0.0
                cum = np.cumsum(np.nan_to_num(f))
                cum[np.isnan(arr)] = np.nan
                curves[y] = [r1(v) for v in cum[JAN1 - 31: JAN1 + 151]]      # Dec 1 – May 31
            reg["forcing"] = {"start": "12-01", "tb": tb, "curves": curves,
                              "threshold": r1(m.params.get("F", m.params.get("a", 0) + m.params.get("b", 0)))}
        forecast["regions"][rkey] = reg

    # ---- hindcast: modelled bloom for every complete historical season, with observations alongside
    history = {}
    for rkey in REGIONS:
        t = temps[rkey]
        first = t.dropna().index.min().year + 1
        series = {g: [] for g in modelled_groups()}
        for y in range(first, last_complete + 1):
            arr, miss = season_array(t, y)
            if miss > 0.03:
                continue
            arr = pd.Series(arr).interpolate(limit_direction="both").to_numpy()
            for g in modelled_groups():
                p = models[g].predict_idx(arr, rkey)
                if not np.isnan(p):
                    series[g].append([y, r1(p - JAN1 + 1)])
        trends = {}
        for g, s in series.items():
            df = pd.DataFrame(s, columns=["y", "doy"])
            for label, since in [("since_1950", 1950), ("since_1990", 1990)]:
                d = df[df.y >= since]
                if len(d) >= 20:
                    slope = np.polyfit(d.y, d.doy, 1)[0] * 10
                    trends.setdefault(g, {})[label] = r1(slope)
            early = df[(df.y >= 1951) & (df.y <= 1980)].doy.mean()
            recent = df[df.y >= last_complete - 29].doy.mean()
            trends.setdefault(g, {})["shift_1951_80_vs_recent30"] = r1(recent - early) if not np.isnan(early) else None
        o = obs[obs.region == rkey]
        history[rkey] = {
            "first_year": first, "station": REGIONS[rkey]["station_label"],
            "model": series, "trends": trends,
            "observed": {g: o[o.group == g][["year", "doy", "q25", "q75", "n"]].round(1).values.tolist() for g in modelled_groups()},
        }

    # ---- backtest by lead time: refit without the target year, forecast from each issue date
    backtest = {}
    for g in modelled_groups():
        rows = rows_by_group[g]
        recs = []
        for y in sorted({yy for _, yy, _, _ in rows}):
            train = [(r, a, i) for r, yy, a, i in rows if yy != y]
            m = fit(chosen[g].split(":")[0], train, fixed.get(g))
            for r, yy, a, i in rows:
                if yy != y:
                    continue
                pool = [ay for ay in range(y - ANALOG_YEARS, y)]
                for mo, d in ISSUE_DATES:
                    issue = date(y, mo, d)
                    obs_date = idx_to_date(y, i)
                    if issue >= obs_date:
                        continue
                    p = analog_forecast(m, temps[r], r, y, issue, pool)
                    if not len(p):
                        continue
                    lo, med, hi = np.percentile(with_residuals(p, g, exclude_year=y), [10, 50, 90])
                    recs.append({"region": r, "year": y, "issue": f"{mo:02d}-{d:02d}", "obs": r1(i - JAN1 + 1),
                                 "pred": r1(med - JAN1 + 1), "lo": r1(lo - JAN1 + 1), "hi": r1(hi - JAN1 + 1)})
        df = pd.DataFrame(recs)
        df["err"] = df.pred - df.obs
        df["hit"] = (df.obs >= df.lo) & (df.obs <= df.hi)
        summ = df.groupby("issue").agg(mae=("err", lambda e: e.abs().mean()), coverage=("hit", "mean"), n=("err", "size")).reset_index()
        backtest[g] = {"summary": summ.round(2).to_dict("records"), "rows": df.drop(columns="hit").to_dict("records")}
        print(f"  backtest {g:<9} " + "  ".join(f"{r.issue}:{r.mae:.1f}d/{r.coverage:.0%}" for r in summ.itertuples()))

    # ---- trees (compact), cultivar catalogue and best streets
    ckeys = list(CULTIVARS)
    streets = sorted(trees.street.fillna("").unique())
    sidx = {s: i for i, s in enumerate(streets)}
    gkeys = list(GROUPS)
    cities = list(TREE_CITIES)
    clean = lambda v, lo, hi: None if v is None or pd.isna(v) or not (lo < v < hi) else round(float(v), 1)
    tree_rows = [[round(lon, 5), round(lat, 5), gkeys.index(g), ckeys.index(ck), sidx[s or ""], cities.index(city),
                  clean(dbh, 0, 300), clean(ht, 0, 40), (addr or "").strip().title()]
                 for lon, lat, g, ck, s, city, dbh, ht, addr in zip(trees.lon, trees.lat, trees.group, trees.cultivar, trees.street,
                                                                    trees.city, trees.dbh_cm, trees.height_m, trees.address)]
    photos = json.loads(PHOTOS.read_text(encoding="utf-8")) if PHOTOS.exists() else {}
    catalogue = {}
    for k, (name, grp, tier, colour, form, habit, note, _) in CULTIVARS.items():
        d = trees[trees.cultivar == k]
        best = {}
        for city in cities:
            dc = d[(d.city == city) & (d.street.fillna("") != "")]
            if len(dc):
                st, n = dc.street.value_counts().index[0], int(dc.street.value_counts().iloc[0])
                sub = dc[dc.street == st]
                best[city] = {"street": st, "n": n, "lon": round(float(sub.lon.median()), 5), "lat": round(float(sub.lat.median()), 5)}
        catalogue[k] = {"name": name, "group": grp, "tier": tier, "colour": colour, "form": form, "habit": habit, "note": note,
                        "counts": d.city.value_counts().to_dict(), "best_street": best, "photo": photos.get(k)}
    best_streets = []
    for (city, street), d in trees[trees.street.fillna("") != ""].groupby(["city", "street"]):
        if len(d) < 12:
            continue
        best_streets.append({"city": city, "region": TREE_CITIES[city], "street": street, "n": len(d),
                             "groups": d.group.value_counts().to_dict(),
                             "lon": r1(d.lon.median() * 1e4) / 1e4, "lat": r1(d.lat.median() * 1e4) / 1e4})
    best_streets.sort(key=lambda s: -s["n"])
    best_streets = [s for c in cities for s in [x for x in best_streets if x["city"] == c][:40]]

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "season": season,
        "regions": {k: {"name": v["name"], "center": v["center"], "station": v["station_label"],
                        "has_trees": k in TREE_CITIES.values(),
                        "tree_cities": [c for c, r in TREE_CITIES.items() if r == k]} for k, v in REGIONS.items()},
        "cities": {c: {"region": r, "name": c.title()} for c, r in TREE_CITIES.items()},
        "tiers": TIER_BLURB,
        "groups": {k: {"label": v["label"], "color": v["color"], "half_window": v["half_window"],
                       "offset_from": v.get("offset_from")} for k, v in GROUPS.items()},
        "model_card": card,
        "counts": {"trees": len(trees), "trees_by_city": trees.city.value_counts().to_dict(),
                   "inat_obs": int(obs.n.sum()), "bloom_years": int(len(obs)),
                   "weather_days": int(sum(t.notna().sum() for t in temps.values()))},
    }
    dump("meta.json", meta)
    dump("forecast.json", forecast)
    dump("history.json", history)
    dump("backtest.json", backtest)
    dump("trees.json", {"cols": ["lon", "lat", "group", "cultivar", "street", "city", "dbh_cm", "height_m", "address"],
                        "groups": gkeys, "cultivars": ckeys, "cities": cities, "streets": streets, "rows": tree_rows})
    dump("cultivars.json", catalogue)
    dump("streets.json", best_streets)
    ok = inat.dropna(subset=["observed_on", "lat", "lon"])
    ok = ok[ok.group.isin(modelled_groups()) & ~ok.flower_annotation.isin([14, 15, 21])]
    for col in ("photo", "photo_attr", "place", "taxon"):
        ok[col] = ok[col].astype(object).where(ok[col].notna(), None) if col in ok else None
    dump("sightings.json", {"cols": ["lon", "lat", "group", "date", "photo", "attribution", "place", "taxon", "obs_id"], "groups": gkeys,
                            "rows": [[round(lo, 4), round(la, 4), gkeys.index(g), d.strftime("%Y-%m-%d"), ph, at, pl, tx, int(oid)]
                                     for lo, la, g, d, ph, at, pl, tx, oid in zip(ok.lon, ok.lat, ok.group, ok.observed_on, ok.photo,
                                                                                  ok.photo_attr, ok.place, ok.taxon, ok.obs_id)]})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", type=lambda s: date.fromisoformat(s), default=date.today())
    main(ap.parse_args().today)
