#!/usr/bin/env python3
"""Sample weekday one-way Japan movements onto existing canonical demand sites.

The published 207-zone ledger is aggregated to directed prefecture controls
until a site-to-207-zone polygon crosswalk is available. No new sites are made.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import gzip
import hashlib
import json
import math
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

TILE_IDS = {"13": "JP_TOKYO_MAINLAND", "14": "JP_KANAGAWA_MAINLAND"}
MAX_GROUP = 200


def tile_id(code: str) -> str:
    return TILE_IDS.get(code, f"JP_PREF_{code}")


def read_gzip(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def write_gzip(path: Path, value) -> None:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as target:
            target.write(encoded)


class Picker:
    def __init__(self, sites: list[dict], weight: str):
        self.sites = sorted(sites, key=lambda site: site["id"])
        self.cumulative = []
        total = 0
        for site in self.sites:
            total += max(0, site[weight])
            self.cumulative.append(total)
        self.uniform = total == 0
        if self.uniform:
            self.cumulative = list(range(1, len(self.sites) + 1))
            total = len(self.sites)
        self.total = total

    def pick(self, seed: str) -> dict:
        index = int(hashlib.sha256(seed.encode()).hexdigest()[:16], 16) % self.total
        return self.sites[bisect.bisect_right(self.cumulative, index)]


def road_estimate(origin: dict, destination: dict) -> tuple[int, int]:
    latitude = math.radians((origin["latitude"] + destination["latitude"]) / 2)
    dx = (origin["longitude"] - destination["longitude"]) * 111_320 * math.cos(latitude)
    dy = (origin["latitude"] - destination["latitude"]) * 110_574
    distance = max(1, round(math.hypot(dx, dy)))
    return max(60, round(distance / 13.4)), distance


def controls(path: Path) -> dict[tuple[str, str], dict]:
    result = defaultdict(lambda: {"estimate": Decimal(0), "sources": set(), "zoneRows": 0})
    with path.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            if row["value_status"] not in ("published_estimate", "modeled_return_allocation"):
                continue
            amount = row["estimated_movements_per_weekday"]
            if not amount:
                continue
            origin, destination = row["origin_prefecture_code"], row["destination_prefecture_code"]
            if origin == destination:
                continue
            item = result[(origin, destination)]
            item["estimate"] += Decimal(amount)
            item["sources"].add(row["source"])
            item["zoneRows"] += 1
    for pair, item in result.items():
        if len(item["sources"]) != 1:
            raise ValueError(f"Overlapping sources for {pair}: {item['sources']}")
        item["source"] = next(iter(item.pop("sources")))
        item["rounded"] = int(item["estimate"].quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return dict(result)


def canonical_sites(base: Path, cross: dict) -> dict[str, dict]:
    sites = {}

    def add(site_id, longitude, latitude, tile, residents, workers):
        site = sites.setdefault(site_id, {"id": site_id, "longitude": longitude, "latitude": latitude,
                                          "tileId": tile, "home_weight": 0, "job_weight": 0})
        if (site["longitude"], site["latitude"], site["tileId"]) != (longitude, latitude, tile):
            raise ValueError(f"Canonical site has inconsistent geometry: {site_id}")
        site["home_weight"] += residents
        site["job_weight"] += workers

    for number in range(1, 48):
        tile = tile_id(f"{number:02d}")
        native = read_gzip(base / "tiles" / tile / "demand_data.json.gz")
        for point in native["points"]:
            add(point["id"], *point["location"], tile, int(point["residents"]), int(point["jobs"]))
    fields = {name: index for index, name in enumerate(cross["pointFields"])}
    for row in cross["points"]:
        add(*(row[fields[name]] for name in ("id", "longitude", "latitude", "tileId", "residents", "workers")))
    return sites


def sample(ledger: Path, base: Path, output: Path) -> dict:
    if output.resolve() == base.resolve() or output.resolve() == (base / "world").resolve():
        raise ValueError("Sampling output must be separate from the baseline demand package")
    output.mkdir(parents=True, exist_ok=True)
    source_catalog_path = base / "world" / "cross_commutes.json"
    source_cross_path = base / "world" / "cross_demand.json.gz"
    catalog = json.loads(source_catalog_path.read_text(encoding="utf-8"))
    cross = read_gzip(source_cross_path)
    if cross["popFields"][-1] == "tripType":
        raise ValueError("Base demand already contains typed trips; use the commute-only base")
    cross["popFields"].append("tripType")
    sites = canonical_sites(base, cross)
    by_tile = defaultdict(list)
    for site in sites.values():
        by_tile[site["tileId"]].append(site)
    origin_pickers = {tile: Picker(items, "home_weight") for tile, items in by_tile.items()}
    destination_pickers = {tile: Picker(items, "job_weight") for tile, items in by_tile.items()}
    source_controls = controls(ledger)
    point_indexes = {row[0]: index for index, row in enumerate(cross["points"])}
    gateways = {gateway["id"] for gateway in catalog["gateways"]}
    sampled_rows = []
    placed = 0
    unplaced = []
    uniform_pairs = []

    def point_index(site):
        index = point_indexes.get(site["id"])
        if index is None:
            index = len(cross["points"])
            cross["points"].append([site["id"], site["longitude"], site["latitude"], site["tileId"], 0, 0])
            point_indexes[site["id"]] = index
        return index

    for (origin, destination), item in sorted(source_controls.items()):
        mass = item["rounded"]
        if not mass:
            continue
        start, end = tile_id(origin), tile_id(destination)
        if start not in origin_pickers or end not in destination_pickers:
            unplaced.append({"origin": origin, "destination": destination, "mass": mass})
            continue
        home_picker, work_picker = origin_pickers[start], destination_pickers[end]
        if home_picker.uniform or work_picker.uniform:
            uniform_pairs.append(f"{origin}-{destination}")
        gateway_id = f"jp-noncommute-{origin}-{destination}"
        if gateway_id in gateways:
            raise ValueError(f"Gateway collision: {gateway_id}")
        gateway_index = len(cross["gateways"])
        cross["gateways"].append(gateway_id)
        catalog["gateways"].append({"id": gateway_id, "capacityPerHour": max(10_000, mass)})
        bucket = {"id": gateway_id, "homeTileId": start, "workTileId": end,
                  "gatewayId": gateway_id, "mass": mass, "tripType": "oneWay",
                  "departureHour": 12}
        catalog["buckets"].append(bucket)
        remaining = mass
        group = 0
        weighted_seconds = 0
        while remaining:
            group += 1
            amount = min(MAX_GROUP, remaining)
            remaining -= amount
            seed = f"{item['source']}|{origin}|{destination}|{group}"
            home = home_picker.pick(f"{seed}|origin")
            work = work_picker.pick(f"{seed}|destination")
            seconds, distance = road_estimate(home, work)
            weighted_seconds += amount * seconds
            pop_id = f"jp-noncommute-{origin}-{destination}-{group:06d}"
            cross["pops"].append([pop_id, amount, point_index(home), point_index(work), gateway_index,
                                  "12:00", "", seconds, distance, "oneWay"])
            sampled_rows.append([pop_id, origin, destination, home["id"], work["id"], amount, item["source"]])
            placed += amount
        bucket["defaultTravelSeconds"] = round(weighted_seconds / mass)

    if unplaced:
        raise ValueError(f"Unplaced prefecture controls: {unplaced}")
    catalog["buildHash"] = f"{catalog['buildHash']}:one-way-v1:{hashlib.sha256(ledger.read_bytes()).hexdigest()}"
    (output / "cross_commutes.json").write_text(json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    write_gzip(output / "cross_demand.json.gz", cross)
    with (output / "sampled_pairs.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target)
        writer.writerow(["pop_id", "origin_prefecture", "destination_prefecture", "origin_site_id", "destination_site_id", "movements_per_weekday", "source"])
        writer.writerows(sampled_rows)
    report = {"schemaVersion": 1, "unit": "one-way movements per representative weekday",
              "placementResolution": "directed prefecture pairs; 207-zone controls aggregated once",
              "baseCatalogSha256": hashlib.sha256(source_catalog_path.read_bytes()).hexdigest(),
              "baseCrossDemandSha256": hashlib.sha256(source_cross_path.read_bytes()).hexdigest(),
              "movementLedgerSha256": hashlib.sha256(ledger.read_bytes()).hexdigest(),
              "canonicalSiteCount": len(sites), "directedPairCount": sum(item["rounded"] > 0 for item in source_controls.values()),
              "sampledGroupCount": len(sampled_rows), "roundedMovementMass": sum(item["rounded"] for item in source_controls.values()),
              "placedMovementMass": placed, "unplaced": unplaced, "uniformFallbackPairs": uniform_pairs,
              "crossPointCount": len(cross["points"]), "crossPopCount": len(cross["pops"])}
    if placed != report["roundedMovementMass"]:
        raise AssertionError("Sampled groups do not conserve rounded directed controls")
    (output / "sampling-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--base-demand", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(sample(arguments.ledger, arguments.base_demand, arguments.output), indent=2))
