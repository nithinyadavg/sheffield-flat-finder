#!/usr/bin/env python3
"""Refresh the bundled live-data snapshots used by the app.

Writes:
  data/osm.json   - bus stops, tram stops, shops/pharmacies, gyms (OpenStreetMap via Overpass, ODbL)
  data/crime.json - street-level crime counts and points per area (data.police.uk, OGL v3)

The app loads these first so the map is instant, then the browser can refresh
OpenStreetMap data itself. Run weekly by .github/workflows/refresh-data.yml,
or by hand:  python3 scripts/refresh_data.py [--skip-osm] [--skip-crime]
Standard library only.
"""
import json, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BBOX = "(53.30,-1.60,53.45,-1.32)"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "sheffield-flat-finder (github.com/nithinyadavg/sheffield-flat-finder)"}

OSM_QUERY = f"""[out:json][timeout:120];
node["highway"="bus_stop"]{BBOX};out skel qt;
make sep kind="tram";out;
node["railway"="tram_stop"]{BBOX};out skel qt;
make sep kind="shop";out;
(nwr["shop"~"^(supermarket|convenience)$"]{BBOX};nwr["amenity"="pharmacy"]{BBOX};);out center qt;
make sep kind="gym";out;
nwr["leisure"~"^(fitness_centre|sports_centre)$"]{BBOX};out center qt;"""


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def refresh_osm():
    body = urllib.parse.urlencode({"data": OSM_QUERY}).encode()
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=body, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                j = json.load(r)
            break
        except Exception as e:  # try the next mirror
            last = e
    else:
        raise SystemExit(f"Overpass failed: {last}")
    pts = {"bus": [], "tram": [], "shop": [], "gym": []}
    kind = "bus"
    for e in j["elements"]:
        if e["type"] == "sep":
            kind = e["tags"]["kind"]
            continue
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None:
            continue
        pts[kind].append([round(lat, 5), round(lon, 5)])
    out = {"source": "OpenStreetMap contributors via Overpass API (ODbL)", "fetched": now(), **pts}
    (DATA / "osm.json").write_text(json.dumps(out, separators=(",", ":")))
    print("osm:", {k: len(v) for k, v in pts.items()})


def crime_poly(a):
    dlat, dlng = 0.0055, 0.009
    corners = [(a["lat"] - dlat, a["lng"] - dlng), (a["lat"] - dlat, a["lng"] + dlng),
               (a["lat"] + dlat, a["lng"] + dlng), (a["lat"] + dlat, a["lng"] - dlng)]
    return ":".join(f"{la:.4f},{lo:.4f}" for la, lo in corners)


def refresh_crime():
    areas = json.loads((DATA / "areas.json").read_text())["areas"]
    counts, pts, month = {}, [], None
    for a in areas:
        url = "https://data.police.uk/api/crimes-street/all-crime?poly=" + crime_poly(a)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                    lst = json.load(r)
                break
            except Exception:
                time.sleep(2 + attempt * 3)
        else:
            print("crime: skipped", a["id"])
            continue
        counts[a["id"]] = len(lst)
        for c in lst:
            month = month or c.get("month")
            loc = c.get("location") or {}
            if loc.get("latitude"):
                pts.append([round(float(loc["latitude"]), 5), round(float(loc["longitude"]), 5)])
        time.sleep(0.3)
    out = {"source": "data.police.uk (Open Government Licence v3.0)", "fetched": now(), "month": month, "counts": counts, "pts": pts}
    (DATA / "crime.json").write_text(json.dumps(out, separators=(",", ":")))
    print("crime:", month, counts)


if __name__ == "__main__":
    if "--skip-osm" not in sys.argv:
        refresh_osm()
    if "--skip-crime" not in sys.argv:
        refresh_crime()
