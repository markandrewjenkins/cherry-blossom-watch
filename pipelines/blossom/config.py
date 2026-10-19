"""Blossom Watch configuration: regions, weather station chains, taxa and cultivar mapping."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "blossom" / "raw"
OUT = ROOT / "site" / "public" / "data" / "blossom"

# Each region: iNaturalist bounding box (nelat, nelng, swlat, swlng) and a chain of ECCC
# climate stations. The first station is the reference; later ones fill its gaps and extend
# it back in time after a monthly bias adjustment over their overlap.
REGIONS = {
    "victoria": {
        "name": "Greater Victoria",
        "bbox": (48.75, -123.20, 48.30, -123.80),
        "center": (-123.36, 48.44),
        "stations": ["1018611", "1018610", "1018598", "1018620", "1018621"],
        "station_label": "Victoria Gonzales (1898– via Gonzales Heights)",
    },
    "vancouver": {
        "name": "Vancouver",
        "bbox": (49.40, -122.95, 49.15, -123.30),
        "center": (-123.12, 49.25),
        "stations": ["1108446", "1108447", "1108395"],
        "station_label": "Vancouver Harbour (1925–)",
    },
    "cowichan": {
        "name": "Cowichan Valley",
        "bbox": (48.95, -123.50, 48.60, -123.95),
        "center": (-123.71, 48.78),
        "stations": ["1015628", "1015630", "1012573", "1012570"],
        "station_label": "North Cowichan (1981–, Duncan Forestry before)",
    },
    "nanaimo": {
        "name": "Nanaimo",
        "bbox": (49.30, -123.85, 49.05, -124.15),
        "center": (-123.94, 49.17),
        "stations": ["10253G0", "1025370", "1025365"],
        "station_label": "Nanaimo City Yard (1981–, Nanaimo A before)",
    },
    "comox": {
        "name": "Comox Valley",
        "bbox": (49.85, -124.80, 49.55, -125.20),
        "center": (-124.95, 49.69),
        "stations": ["1021830"],
        "station_label": "Comox A (1944–)",
    },
}

# Bloom groups that are modelled. `taxon_id` is the iNaturalist taxon used to measure
# the observed bloom date each year; `offset_from` marks groups derived from another one.
GROUPS = {
    "plum":     {"label": "Purple-leaf & cherry plums", "taxon_id": 55837,  "obs_window": (15, 140), "color": "#c2185b", "half_window": 10},
    "early":    {"label": "Early cherries (Accolade, Higan, Sargent…)", "offset_from": ("japanese", -21), "color": "#ec407a", "half_window": 7},
    "yoshino":  {"label": "Yoshino, Akebono & Snow Goose", "offset_from": ("japanese", -12), "color": "#f48fb1", "half_window": 7},
    "japanese": {"label": "Japanese flowering cherries (Kanzan, Shirofugen…)", "taxon_id": 125742, "obs_window": (50, 150), "borrow_from": ["plum", "wild", "bitter"], "color": "#ff80ab", "half_window": 8},
    "wild":     {"label": "Wild & sweet cherry", "taxon_id": 61964, "obs_window": (50, 150), "color": "#f8bbd0", "half_window": 7},
    "bitter":   {"label": "Native bitter cherry", "taxon_id": 63905, "obs_window": (60, 166), "color": "#fce4ec", "half_window": 7},
}

# iNaturalist "Flowers and Fruits" annotation (term 12). Values other than 13 (flowers)
# mean the plant was photographed without open flowers, so those records are dropped.
INAT_TERM_FLOWERING = 12
INAT_VALUE_FLOWERS = 13
INAT_FIRST_YEAR = 2016

