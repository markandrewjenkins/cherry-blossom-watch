"""Trip-planner networks and ready-made blossom routes for Cherry Blossom Watch.

  python -m pipelines.blossom.trips

Run after pipelines.blossom.build: it reads the processed tree and cultivar files and writes
trip_<region>_<mode>.json (road networks with each street's trees by cultivar) and trips.json (ready-made routes).
"""
from __future__ import annotations

import json

import pandas as pd

from pipelines.common import treetrips

from pathlib import Path

from .config import RAW

OUT = Path(__file__).resolve().parents[2] / "site" / "public" / "data" / "blossom"
SHARED = Path(__file__).resolve().parents[2] / "data" / "sunday" / "raw"     # reuse Sunday Drive's road download when present
OSM = Path(__file__).resolve().parents[2] / "data" / "osm"                  # city extracts (.osm.pbf) from BBBike
CITIES = {
    "victoria": {"pbf": "Victoria", "bbox": (48.400, -123.440, 48.475, -123.300), "tree_cities": ["victoria", "esquimalt"]},
    "vancouver": {"pbf": "Vancouver", "bbox": (49.195, -123.230, 49.320, -123.020), "tree_cities": ["vancouver"]},
}


def main():
    T = json.loads((OUT / "trees.json").read_text(encoding="utf-8"))
    cv = json.loads((OUT / "cultivars.json").read_text(encoding="utf-8"))
    rows = pd.DataFrame(T["rows"], columns=T["cols"])      # lon, lat, group, cultivar, street (index), city (index), …
    rows["street"] = rows["street"].map(lambda i: T["streets"][i] if 0 <= i < len(T["streets"]) else "")
    rows["cls"] = rows["cultivar"].astype(int)
    rows["cityname"] = rows["city"].map(lambda i: T["cities"][i])
    good = {i for i, k in enumerate(T["cultivars"]) if cv[k]["tier"] in ("S", "A")}
    out = {}
    for key, c in CITIES.items():
        print(f"{key}…", flush=True)
        t = rows[rows.cityname.isin(c["tree_cities"])]
        out[key] = {"presets": treetrips.build_city(key, c["bbox"], RAW / f"trip_{key}", OUT, "trip_", t, good,
                                                   shared=[SHARED / key / "roads.json"], pbf_city=c["pbf"], osm_dir=OSM, label="S- and A-tier cherries")}
    (OUT / "trips.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("  wrote trips.json", flush=True)


if __name__ == "__main__":
    main()
