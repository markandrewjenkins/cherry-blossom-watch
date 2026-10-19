"""Download raw inputs for Cherry Blossom Watch.

  python -m pipelines.blossom.fetch [trees|inat|weather|all]

Writes parquet files to data/blossom/raw/.
"""
from __future__ import annotations

import sys
from datetime import date

import pandas as pd

from pipelines.common.eccc import climate_daily
from pipelines.common.http import get_json

from .config import GROUPS, INAT_FIRST_YEAR, INAT_TERM_FLOWERING, RAW, REGIONS
from .cultivars import CULTIVARS, cultivar_key

VAN_TREES = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/json"
VIC_TREES = "https://maps.victoria.ca/server/rest/services/OpenData/OpenData_Parks/MapServer/15/query"
ESQ_TREES = "https://gis.esquimalt.ca/arcgis/rest/services/Services/Trees/MapServer/0/query"
INAT_OBS = "https://api.inaturalist.org/v1/observations"


def _street_from_address(addr: str | None) -> str:
    """'2000 W GEORGIA ST' -> 'W Georgia St'."""
    parts = (addr or "").split()
    if parts and parts[0].replace("-", "").isdigit():
        parts = parts[1:]
    return " ".join(parts).title()


def fetch_trees() -> pd.DataFrame:
    print("Vancouver public trees (Prunus)…")
    van = get_json(VAN_TREES, {
        "where": 'genus_name="PRUNUS"',
        "select": "asset_id,address,local_area,species_name,cultivar_name,common_name,diameter_cm,height_m,geo_point_2d",
    })
    v = pd.DataFrame([{
        "city": "vancouver", "id": f"van-{r['asset_id']}",
        "botanical": " ".join(x for x in ["Prunus", (r.get("species_name") or "").title(),
                                          (r.get("cultivar_name") or "").title()] if x and x != "None"),
        "common": (r.get("common_name") or "").title(),
        "street": _street_from_address(r.get("address")),
        "area": (r.get("local_area") or "").title(),
        "address": r.get("address"),
        "dbh_cm": r.get("diameter_cm"),
        "height_m": r.get("height_m"),
        "lon": (r.get("geo_point_2d") or {}).get("lon"),
        "lat": (r.get("geo_point_2d") or {}).get("lat"),
    } for r in van])
    print(f"  {len(v):,} trees")

    print("City of Victoria tree species (Prunus)…")
    rows, offset = [], 0
    while True:
        d = get_json(VIC_TREES, {
            "where": "BotanicalName LIKE 'Prunus%'", "outFields": "SiteID,Address,OnStreet,Street,BotanicalName,CommonName,DiameterAtBreastHeight,Height,Area,Parks",
            "outSR": 4326, "f": "json", "resultOffset": offset, "resultRecordCount": 2000, "orderByFields": "OBJECTID"})
        feats = d.get("features", [])
        for f in feats:
            a, g = f["attributes"], f.get("geometry") or {}
            rows.append({
                "city": "victoria", "id": f"vic-{a.get('SiteID')}",
                "botanical": a.get("BotanicalName"), "common": a.get("CommonName"),
                "street": (a.get("OnStreet") or a.get("Street") or a.get("Parks") or "").title(),
                "area": (a.get("Area") or "").title(),
                "address": " ".join(x for x in [str(a.get("Address") or "").strip(), (a.get("OnStreet") or a.get("Street") or "").title()] if x),
                "dbh_cm": a.get("DiameterAtBreastHeight"), "height_m": a.get("Height"),
                "lon": g.get("x"), "lat": g.get("y")})
        if len(feats) < 2000:
            break
        offset += 2000
    vi = pd.DataFrame(rows)
    print(f"  {len(vi):,} trees")

    print("Township of Esquimalt trees (Prunus)…")
    rows, offset = [], 0
    while True:
        d = get_json(ESQ_TREES, {
            "where": "SPP_bot LIKE 'Prunus%'", "outFields": "uniqueid,site_id,SPP_bot,SPP_com,DBH,address,onstr,street,suffix,active",
            "outSR": 4326, "f": "json", "resultOffset": offset, "resultRecordCount": 1000, "orderByFields": "OBJECTID"})
        feats = d.get("features", [])
        for f in feats:
            a, g = f["attributes"], f.get("geometry") or {}
            if a.get("active") == 0:
                continue
            named = " ".join(x for x in [a.get("street"), a.get("suffix")] if x and str(x).lower() != "unassigned")
            on = a.get("onstr") if a.get("onstr") and "unassigned" not in str(a.get("onstr")).lower() else None
            street = (on or named or "").title()
            rows.append({
                "city": "esquimalt", "id": f"esq-{a.get('uniqueid') or a.get('site_id')}",
                "botanical": a.get("SPP_bot"), "common": a.get("SPP_com"), "street": street, "area": "Esquimalt",
                "address": " ".join(x for x in [str(a.get("address") or "").strip(), street] if x),
                "dbh_cm": a.get("DBH"), "height_m": None, "lon": g.get("x"), "lat": g.get("y")})
        if len(feats) < 1000:
            break
        offset += 1000
    es = pd.DataFrame(rows)
    print(f"  {len(es):,} trees")

    trees = pd.concat([v, vi, es], ignore_index=True).dropna(subset=["lon", "lat"])
    trees["cultivar"] = [cultivar_key(b, c) for b, c in zip(trees.botanical, trees.common)]
    trees = trees[trees.cultivar.notna()].reset_index(drop=True)
    trees["group"] = trees.cultivar.map(lambda k: CULTIVARS[k][1])
    print(trees.groupby(["city", "group"]).size().unstack(fill_value=0))
    RAW.mkdir(parents=True, exist_ok=True)
    trees.to_parquet(RAW / "trees.parquet", index=False)
    return trees


def fetch_inat() -> pd.DataFrame:
    rows = []
    for rkey, reg in REGIONS.items():
        nelat, nelng, swlat, swlng = reg["bbox"]
        for gkey, grp in GROUPS.items():
            if "taxon_id" not in grp:
                continue
            id_above, n = 0, 0
            while True:
                d = get_json(INAT_OBS, {
                    "taxon_id": grp["taxon_id"], "nelat": nelat, "nelng": nelng, "swlat": swlat, "swlng": swlng,
                    "verifiable": "any", "d1": f"{INAT_FIRST_YEAR}-01-01", "month": "1,2,3,4,5,6",
                    "per_page": 200, "order_by": "id", "order": "asc", "id_above": id_above,
                }, min_interval=1.1)
                res = d.get("results", [])
                for o in res:
                    flower_vals = [a["controlled_value_id"] for a in o.get("annotations", [])
                                   if a.get("controlled_attribute_id") == INAT_TERM_FLOWERING]
                    lat = lon = None
                    if o.get("location"):
                        lat, lon = map(float, o["location"].split(","))
                    photo = next((ph for ph in o.get("photos", []) if ph.get("license_code")), None)
                    rows.append({"region": rkey, "group": gkey, "obs_id": o["id"], "observed_on": o.get("observed_on"),
                                 "quality": o.get("quality_grade"), "flower_annotation": flower_vals[0] if flower_vals else None,
                                 "lat": lat, "lon": lon, "place": o.get("place_guess"),
                                 "taxon": (o.get("taxon") or {}).get("preferred_common_name") or (o.get("taxon") or {}).get("name"),
                                 "photo": photo["url"].replace("/square.", "/small.") if photo else None,
                                 "photo_attr": photo.get("attribution") if photo else None,
                                 "photo_license": photo.get("license_code") if photo else None})
                n += len(res)
                if len(res) < 200:
                    break
                id_above = res[-1]["id"]
            print(f"  {reg['name']:<18} {gkey:<9} {n:>5} obs")
    df = pd.DataFrame(rows)
    df["observed_on"] = pd.to_datetime(df["observed_on"], errors="coerce")
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / "inat.parquet", index=False)
    return df


def fetch_weather() -> pd.DataFrame:
    frames = []
    for rkey, reg in REGIONS.items():
        for sid in reg["stations"]:
            df = climate_daily(sid)
            df["station"], df["region"] = sid, rkey
            print(f"  {reg['name']:<18} {sid}: {len(df):,} days "
                  f"{df.date.min():%Y-%m-%d} → {df.date.max():%Y-%m-%d}" if len(df) else f"  {sid}: none")
            frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    RAW.mkdir(parents=True, exist_ok=True)
    out.to_parquet(RAW / "weather.parquet", index=False)
    return out


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"Fetching {what} ({date.today()})")
    if what in ("trees", "all"):
        fetch_trees()
    if what in ("inat", "all"):
        fetch_inat()
    if what in ("weather", "all"):
        fetch_weather()
