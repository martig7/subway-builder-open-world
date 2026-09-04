"""Compare a ferry-enriched package against its completed OSRM source."""
import argparse
import gzip
import json
import sqlite3
from collections import Counter
from pathlib import Path


def read(path):
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def audit(before: Path, after: Path, cache: Path):
    connection = sqlite3.connect(f"{cache.resolve().as_uri()}?mode=ro", uri=True)
    successful = set(connection.execute(
        "SELECT origin_longitude_e7,origin_latitude_e7,destination_longitude_e7,destination_latitude_e7 "
        "FROM route_cache WHERE source='osrm'"
    ))
    result, tiles = Counter(), {}
    for source in sorted((before / "tiles").glob("*/demand_data.json.gz")):
        old, new = read(source), read(after / source.relative_to(before))
        assert old["points"] == new["points"], f"Demand points changed: {source}"
        result["unchangedNativePoints"] += len(old["points"])
        points = {str(p["id"]): p["location"] for p in old["points"]}
        updated = {str(pop["id"]): pop for pop in new["pops"]}
        assert len(old["pops"]) == len(updated), "Cohorts changed"
        changed = 0
        for pop in old["pops"]:
            other = updated[str(pop["id"])]
            fields = {"drivingSeconds", "drivingDistance"}
            assert {k: v for k, v in pop.items() if k not in fields} == {
                k: v for k, v in other.items() if k not in fields}, "Non-routing demand changed"
            if any(pop[k] != other[k] for k in fields):
                coordinates = (*points[str(pop["residenceId"])], *points[str(pop["jobId"])])
                pair = tuple(round(float(v) * 10**7) for v in coordinates)
                assert pair not in successful, "Previously successful OSRM native route changed"
                changed += 1
        tiles[source.parent.name] = changed
        result["nativeCohorts"] += len(old["pops"])
        result["changedNativeCohorts"] += changed
    old, new = (read(root / "world" / "cross_demand.json.gz") for root in (before, after))
    assert old["points"] == new["points"], "Cross demand locations changed"
    assert old["popFields"] == new["popFields"], "Cross demand schema changed"
    time_field, distance_field = (old["popFields"].index(f) for f in ("drivingSeconds", "drivingDistance"))
    assert len(old["pops"]) == len(new["pops"]), "Cross cohorts changed"
    for a, b in zip(old["pops"], new["pops"]):
        assert all(x == y for i, (x, y) in enumerate(zip(a, b)) if i not in (time_field, distance_field)), "Cross demand changed"
        result["changedCrossCohorts"] += int(a != b)
    result["crossCohorts"] = len(old["pops"])
    connection.close()
    return {"status": "passed", "counts": dict(result), "changedNativeByTile": tiles,
            "demandCoordinatesAndMassPreserved": True,
            "successfulNativeOsrmRoutesPreserved": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.before, args.after, args.cache), sort_keys=True), flush=True)
