"""Gather candidate 'in full bloom' photos per cultivar and write the chosen ones.

  python -m pipelines.blossom.photos candidates   # contact sheets in data/blossom/raw/commons/
  python -m pipelines.blossom.photos choose       # writes cultivar_photos.json from PICKS

Sources: Wikimedia Commons cultivar categories (named cherries) and iNaturalist taxon
photos (wild and fruiting species). Only openly licensed images are used, with credit.
"""
from __future__ import annotations

import html
import io
import json
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw

from .config import RAW

UA = "OpenDataPortfolioBlossomWatch/0.1 (personal data-science portfolio; non-commercial)"
API = "https://commons.wikimedia.org/w/api.php"
DIR = RAW / "commons"
OUT = Path(__file__).with_name("cultivar_photos.json")
S = requests.Session()
S.headers["User-Agent"] = UA

# cultivar -> ("commons", category search) or ("inat", taxon name)
SOURCES = {
    "akebono": ("commons", "Prunus Akebono"), "yoshino": ("commons", "Prunus yedoensis Somei-yoshino"),
    "kanzan": ("commons", "Prunus serrulata Kanzan"), "shirotae": ("commons", "Prunus Shirotae"),
    "ukon": ("commons", "Prunus Ukon"), "taihaku": ("commons", "Prunus Tai Haku"), "shirofugen": ("commons", "Prunus Shirofugen"),
    "amanogawa": ("commons", "Prunus Amanogawa"), "weeping": ("commons", "Prunus pendula"), "accolade": ("commons", "Prunus Accolade"),
    "pinkperfection": ("commons", "Prunus Pink Perfection"), "snowgoose": ("commons", "Prunus Snow Goose"),
    "umineko": ("commons", "Prunus Umineko"), "whitcomb": ("commons", "Prunus Whitcomb"),
    "higan": ("commons", "Prunus subhirtella Autumnalis"), "sargent": ("inat", "Prunus sargentii"),
    "royalburgundy": ("commons", "Prunus Royal Burgundy"), "jpcherry": ("commons", "Prunus serrulata"),
    "blireana": ("commons", "Prunus blireana"), "purpleplum": ("commons", "Prunus cerasifera Nigra"),
    "cherryplum": ("inat", "Prunus cerasifera"), "hillier": ("commons", "Prunus Spire"), "apricot": ("inat", "Prunus mume"),
    "wildcherry": ("inat", "Prunus avium"), "bittercherry": ("inat", "Prunus emarginata"), "chokecherry": ("inat", "Prunus virginiana"),
    "birdcherry": ("inat", "Prunus padus"), "fruitcherry": ("inat", "Prunus cerasus"), "plum": ("inat", "Prunus domestica"),
    "paperbark": ("inat", "Prunus serrula"), "manchurian": ("inat", "Prunus maackii"), "cherry": ("commons", "Cherry blossoms in Vancouver"),
}


def get(url, **kw):
    for _ in range(10):
        r = S.get(url, timeout=60, **kw)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("retry-after", 10)) + 3)
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f"rate limited: {url}")


def strip_tags(s: str) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", "", s or ""))
    s = re.sub(r"\.mw-parser-output.*$", "", s, flags=re.S)          # inline CSS leaking from Commons templates
    s = re.sub(r"^\(c\)\s*", "", s.strip())
    s = re.sub(r",?\s*(some|all) rights reserved.*$", "", s, flags=re.I)
    s = re.sub(r"^Photo by (and \(c\)\d{4} )?", "", s)
    return s.strip(" .")


def commons_candidates(query: str, n: int = 8) -> list[dict]:
    cats = get(API, params={"action": "query", "format": "json", "list": "search", "srnamespace": 14, "srlimit": 2,
                            "srsearch": query}).json().get("query", {}).get("search", [])
    out = []
    for cat in cats[:1]:
        time.sleep(2)
        r = get(API, params={"action": "query", "format": "json", "generator": "categorymembers", "gcmtitle": cat["title"],
                             "gcmtype": "file", "gcmlimit": n, "prop": "imageinfo", "iiprop": "url|extmetadata|mime",
                             "iiurlwidth": 480}).json()
        for p in r.get("query", {}).get("pages", {}).values():
            ii = p.get("imageinfo", [{}])[0]
            if not ii.get("mime", "").startswith("image/jpeg"):
                continue
            md = ii.get("extmetadata", {})
            out.append({"source": "commons", "category": cat["title"], "title": p["title"], "thumb": ii.get("thumburl"),
                        "page": ii.get("descriptionurl"), "license": md.get("LicenseShortName", {}).get("value", ""),
                        "credit": strip_tags(md.get("Artist", {}).get("value", ""))[:80]})
    return out


def commons_file_candidates(query: str, n: int = 10) -> list[dict]:
    r = get(API, params={"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrlimit": n,
                         "gsrsearch": f"{query} filetype:bitmap", "prop": "imageinfo", "iiprop": "url|extmetadata|mime",
                         "iiurlwidth": 480}).json()
    out = []
    for p in sorted(r.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 99)):
        ii = p.get("imageinfo", [{}])[0]
        if not ii.get("mime", "").startswith("image/jpeg"):
            continue
        md = ii.get("extmetadata", {})
        out.append({"source": "commons", "title": p["title"], "thumb": ii.get("thumburl"), "page": ii.get("descriptionurl"),
                    "license": md.get("LicenseShortName", {}).get("value", ""),
                    "credit": strip_tags(md.get("Artist", {}).get("value", ""))[:80]})
    return out


def inat_candidates(name: str, n: int = 8) -> list[dict]:
    t = get("https://api.inaturalist.org/v1/taxa", params={"q": name, "rank": "species,hybrid", "per_page": 1}).json()["results"]
    if not t:
        return []
    tid = t[0]["id"]
    time.sleep(1.2)
    obs = get("https://api.inaturalist.org/v1/observations", params={
        "taxon_id": tid, "term_id": 12, "term_value_id": 13, "quality_grade": "research", "photo_license": "cc-by,cc-by-sa,cc0",
        "order_by": "votes", "per_page": n}).json()["results"]
    out = []
    for o in obs:
        ph = o["photos"][0]
        out.append({"source": "inat", "title": f"{name} (obs {o['id']})", "thumb": ph["url"].replace("/square.", "/medium."),
                    "page": f"https://www.inaturalist.org/observations/{o['id']}", "license": (ph.get("license_code") or "").upper(),
                    "credit": strip_tags(ph.get("attribution", ""))[:80]})
    return out


def candidates() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    cands = {}
    for key, (src, q) in SOURCES.items():
        cands[key] = commons_candidates(q) if src == "commons" else inat_candidates(q)
        print(f"{key:<15} {len(cands[key])}", flush=True)
        time.sleep(2.5)
    (DIR / "candidates.json").write_text(json.dumps(cands, indent=1), encoding="utf-8")
    W, H = 160, 120
    keys = list(cands)
    for part in range(0, len(keys), 8):
        ks = keys[part:part + 8]
        sheet = Image.new("RGB", (120 + 8 * (W + 4), len(ks) * (H + 4)), "white")
        d = ImageDraw.Draw(sheet)
        for r_, k in enumerate(ks):
            d.text((4, r_ * (H + 4) + 50), k, fill="black")
            for c_, cd in enumerate(cands[k][:8]):
                try:
                    im = Image.open(io.BytesIO(get(cd["thumb"]).content)).convert("RGB")
                    im.thumbnail((W, H))
                    sheet.paste(im, (120 + c_ * (W + 4), r_ * (H + 4)))
                    d.rectangle((120 + c_ * (W + 4), r_ * (H + 4), 120 + c_ * (W + 4) + 14, r_ * (H + 4) + 12), fill="black")
                    d.text((120 + c_ * (W + 4) + 3, r_ * (H + 4)), str(c_), fill="yellow")
                except Exception as e:
                    print("thumb fail", k, c_, e)
                time.sleep(1.2)
        sheet.save(DIR / f"sheet_{part // 8}.jpg", quality=85)
        print("sheet", part // 8, flush=True)


# second-pass sources for cultivars the first pass couldn't find
RETRY = {
    "kanzan": ("files", "Kanzan cherry blossoms"),
    "weeping": ("commons", "Prunus subhirtella Pendula"), "snowgoose": ("inat", "Prunus incisa"),
    "blireana": ("inat", "Prunus blireana"), "whitcomb": ("commons", "Prunus subhirtella"),
    "pinkperfection": ("commons", "Prunus serrulata Shogetsu"), "umineko": ("commons", "Prunus Umineko cherry"),
    "taihaku": ("commons", "Prunus Taihaku"), "shirofugen": ("commons", "Prunus Shirofugen"),
    "sargent": ("commons", "Prunus sargentii"), "royalburgundy": ("commons", "Prunus Royal Burgundy"),
}

# cultivars with no usable open photo borrow a look-alike, labelled as such on the site
SIMILAR = {"hillier": "sargent", "manchurian": "birdcherry", "umineko": "shirotae", "pinkperfection": "kanzan",
           "snowgoose": "shirotae", "whitcomb": "higan", "blireana": "purpleplum", "fruitcherry": "wildcherry",
           "cherry": "jpcherry"}

# chosen candidate index per cultivar (filled in after reviewing the contact sheets)
PICKS: dict[str, int] = {
    "akebono": 2, "yoshino": 7, "kanzan": 8, "shirotae": 2, "ukon": 2, "taihaku": 0, "shirofugen": 0, "amanogawa": 6,
    "weeping": 6, "accolade": 2, "higan": 7, "sargent": 0, "royalburgundy": 0, "jpcherry": 0, "purpleplum": 7,
    "cherryplum": 1, "apricot": 0, "wildcherry": 2, "bittercherry": 0, "chokecherry": 2, "birdcherry": 6, "plum": 1,
    "paperbark": 0,
}


def retry() -> None:
    cands = json.loads((DIR / "candidates.json").read_text(encoding="utf-8"))
    for key, (src, q) in RETRY.items():
        extra = {"commons": commons_candidates, "files": commons_file_candidates, "inat": inat_candidates}[src](q)
        seen = {c["title"] for c in cands.get(key, [])}
        cands[key] = cands.get(key, []) + [c for c in extra if c["title"] not in seen]
        print(f"{key:<15} {len(cands[key])}", flush=True)
        time.sleep(2.5)
    (DIR / "candidates.json").write_text(json.dumps(cands, indent=1), encoding="utf-8")
    sheet(cands, list(RETRY), "retry")


def sheet(cands: dict, keys: list[str], name: str) -> None:
    W, H = 160, 120
    for part in range(0, len(keys), 8):
        ks = keys[part:part + 8]
        img = Image.new("RGB", (120 + 10 * (W + 4), len(ks) * (H + 4)), "white")
        d = ImageDraw.Draw(img)
        for r_, k in enumerate(ks):
            d.text((4, r_ * (H + 4) + 50), k, fill="black")
            for c_, cd in enumerate(cands[k][:10]):
                try:
                    im = Image.open(io.BytesIO(get(cd["thumb"]).content)).convert("RGB")
                    im.thumbnail((W, H))
                    img.paste(im, (120 + c_ * (W + 4), r_ * (H + 4)))
                    d.rectangle((120 + c_ * (W + 4), r_ * (H + 4), 120 + c_ * (W + 4) + 14, r_ * (H + 4) + 12), fill="black")
                    d.text((120 + c_ * (W + 4) + 3, r_ * (H + 4)), str(c_), fill="yellow")
                except Exception as e:
                    print("thumb fail", k, c_, e)
                time.sleep(1.2)
        img.save(DIR / f"{name}_{part // 8}.jpg", quality=85)


def choose() -> None:
    cands = json.loads((DIR / "candidates.json").read_text(encoding="utf-8"))
    out = {}
    for k, i in PICKS.items():
        c = cands[k][i]
        out[k] = {"thumb": c["thumb"], "page": c["page"], "license": c["license"], "credit": (strip_tags(c["credit"]) if not c["credit"].lower().startswith("no rights") else "iNaturalist observer") or "Unknown",
                  "source": c["source"]}
    for k, like in SIMILAR.items():
        if k not in out and like in out:
            out[k] = {**out[like], "similar": like}
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(out)} photos to {OUT.name}")


if __name__ == "__main__":
    {"candidates": candidates, "retry": retry, "choose": choose}[sys.argv[1]]()
