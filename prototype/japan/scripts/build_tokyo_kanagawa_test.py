#!/usr/bin/env python3
"""Build the Tokyo--Kanagawa open-world demand prototype from downloaded e-Stat data.

This compiles statistical inputs only.  It deliberately does not claim that a
mesh centroid is a building; building-footprint allocation happens in the map
compiler after the licensed/open footprint source has been chosen.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import zipfile
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from openpyxl import load_workbook
from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw-data" / "estat" / "od"
GENERATED = ROOT / "generated" / "tokyo-kanagawa-test"
PREFECTURES = {"13": "Tokyo", "14": "Kanagawa"}
METRIC_CRS = "EPSG:6677"  # JGD2011 / Japan Plane Rectangular CS IX


def number(value: object) -> int:
    """Convert published e-Stat values, including suppression markers, to ints."""
    if value is None:
        return 0
    text = str(value).strip().replace(",", "")
    if not text or text in {"*", "-", "X"}:
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def mesh_center(code: str) -> tuple[float, float]:
    """Return longitude/latitude of a Japanese 500 m or 250 m mesh centre.

    8-digit third-level meshes are 1 km, 9-digit meshes are 500 m, and
    10-digit meshes are 250 m.  The downloaded source files use 9 and 10.
    """
    if not code.isdigit() or len(code) not in {9, 10}:
        raise ValueError(f"Unexpected Japanese mesh code: {code!r}")
    lat_seconds = int(code[:2]) * 2 * 60 * 60 // 3
    lon_seconds = (100 + int(code[2:4])) * 60 * 60
    lat_seconds += int(code[4]) * 5 * 60 + int(code[6]) * 30
    lon_seconds += int(code[5]) * 7.5 * 60 + int(code[7]) * 45
    if len(code) >= 9:
        quadrant = int(code[8])
        if quadrant not in {1, 2, 3, 4}:
            raise ValueError(f"Unexpected 500 m mesh quadrant: {code!r}")
        if quadrant in {3, 4}:
            lat_seconds += 15
        if quadrant in {2, 4}:
            lon_seconds += 22.5
    if len(code) == 9:
        lat_seconds += 7.5
        lon_seconds += 11.25
    if len(code) == 10:
        quadrant = int(code[9])
        if quadrant not in {1, 2, 3, 4}:
            raise ValueError(f"Unexpected 250 m mesh quadrant: {code!r}")
        if quadrant in {3, 4}:
            lat_seconds += 7.5
        if quadrant in {2, 4}:
            lon_seconds += 11.25
        lat_seconds += 3.75
        lon_seconds += 5.625
    return lon_seconds / 3600, lat_seconds / 3600


def polygon_parts(geometry: Any) -> list[Any]:
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type in {"MultiPolygon", "GeometryCollection"}:
        return [part for child in geometry.geoms for part in polygon_parts(child)]
    return []


class BoundaryOwnershipIndex:
    def __init__(self, selected: dict[str, Any], all_prefectures: dict[str, Any]) -> None:
        self.selected_parts = []
        self.selected_codes = []
        for pref_code, geometry in selected.items():
            parts = polygon_parts(geometry)
            self.selected_parts.extend(parts)
            self.selected_codes.extend([pref_code] * len(parts))
        self.selected_tree = STRtree(self.selected_parts)
        self.all_parts = [part for geometry in all_prefectures.values() for part in polygon_parts(geometry)]
        self.all_tree = STRtree(self.all_parts)


def load_test_boundary() -> tuple[dict[str, Any], dict[str, Any], BoundaryOwnershipIndex]:
    source = json.loads((ROOT / "generated" / "japan-prefecture-boundaries.map.geojson").read_text(encoding="utf-8"))
    features = [feature for feature in source["features"] if feature["properties"]["pref_code"] in PREFECTURES]
    if len(features) != 2:
        raise ValueError("Expected Tokyo and Kanagawa in the prefecture-boundary input")
    selected = {feature["properties"]["pref_code"]: make_valid(shape(feature["geometry"])) for feature in features}
    all_prefectures = {
        feature["properties"]["pref_code"]: make_valid(shape(feature["geometry"]))
        for feature in source["features"]
    }
    return {"type": "FeatureCollection", "features": features}, selected, BoundaryOwnershipIndex(selected, all_prefectures)


def assign_prefecture(code: str, boundary_index: BoundaryOwnershipIndex) -> tuple[str, float, str] | None:
    """Own a mesh by its polygon, without mistaking a water centroid for no data."""
    longitude, latitude = mesh_center(code)
    center = Point(longitude, latitude)
    center_hits = boundary_index.selected_tree.query(center, predicate="covered_by")
    if len(center_hits):
        pref_code = min(boundary_index.selected_codes[int(index)] for index in center_hits)
        return pref_code, 1.0, "center-inside-prefecture"
    if len(code) == 10:
        half_longitude, half_latitude = 0.0015625, 1 / 960
    elif len(code) == 9:
        half_longitude, half_latitude = 0.003125, 1 / 480
    else:
        raise ValueError(f"Unexpected Japanese mesh code: {code!r}")
    cell = box(
        longitude - half_longitude,
        latitude - half_latitude,
        longitude + half_longitude,
        latitude + half_latitude,
    )
    overlaps: dict[str, float] = defaultdict(float)
    for index in boundary_index.selected_tree.query(cell, predicate="intersects"):
        part_index = int(index)
        overlaps[boundary_index.selected_codes[part_index]] += boundary_index.selected_parts[part_index].intersection(cell).area
    if not overlaps:
        return None
    pref_code, overlap_area = max(overlaps.items(), key=lambda item: (item[1], item[0]))
    if overlap_area <= 0:
        return None
    if len(boundary_index.all_tree.query(center, predicate="covered_by")):
        return pref_code, overlap_area / cell.area, "neighbor-prefecture-border-fraction"
    return pref_code, 1.0, "coastal-water-centroid"


def rows_from_zip(path: Path, encoding: str = "cp932") -> Iterable[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".txt")]
        if len(names) != 1:
            raise ValueError(f"Expected one table in {path.name}, found {names}")
        with archive.open(names[0]) as handle:
            # The second human-readable title row is not part of the table.
            reader = csv.DictReader((line.decode(encoding) for line in handle))
            next(reader, None)
            yield from reader


def source_mesh_intersects(path: Path, selected_boundary: Any) -> bool:
    prefix = path.stem.rsplit("-M", 1)[-1]
    if len(prefix) != 4 or not prefix.isdigit():
        raise ValueError(f"Cannot read first-level mesh from {path.name}")
    min_latitude = int(prefix[:2]) * 2 / 3
    min_longitude = 100 + int(prefix[2:])
    return selected_boundary.intersects(
        box(min_longitude, min_latitude, min_longitude + 1, min_latitude + 2 / 3)
    )


def read_home_mesh(boundary_index: BoundaryOwnershipIndex, selected_boundary: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    source_dir = RAW / "2020-census-250m-origin-marginals"
    for source in sorted(source_dir.glob("*.zip")):
        if not source_mesh_intersects(source, selected_boundary):
            continue
        for row in rows_from_zip(source):
            # 0 is an unchanged released cell and 1 is a disclosure-merged
            # released cell.  2 is an input cell represented by its HTKSAKI.
            if row.get("HTKSYORI") not in {"0", "1"}:
                continue
            code = row["KEY_CODE"]
            commuters = number(row.get("T001109086"))
            if commuters <= 0:
                continue
            assignment = assign_prefecture(code, boundary_index)
            if assignment is None:
                continue
            pref_code, factor, assignment_kind = assignment
            longitude, latitude = mesh_center(code)
            commuters = round(commuters * factor)
            if commuters <= 0:
                continue
            records.append({
                "id": f"home-250m-{code}", "meshCode": code,
                "longitude": longitude, "latitude": latitude,
                "commuters": commuters,
                "workers": round(number(row.get("T001109087")) * factor),
                "students": round(number(row.get("T001109088")) * factor),
                "railUsers": round(number(row.get("T001109090")) * factor),
                "prefCode": pref_code,
                "boundaryAssignment": assignment_kind,
            })
    return sorted(records, key=lambda record: record["meshCode"])


def read_job_mesh(boundary_index: BoundaryOwnershipIndex, selected_boundary: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    source_dir = RAW / "2021-economic-census-500m-destination-capacity"
    for source in sorted(source_dir.glob("*.zip")):
        if not source_mesh_intersects(source, selected_boundary):
            continue
        for row in rows_from_zip(source):
            code = row["KEY_CODE"]
            capacity = number(row.get("T001162022"))  # all-industry employees
            if capacity <= 0:
                continue
            assignment = assign_prefecture(code, boundary_index)
            if assignment is None:
                continue
            pref_code, factor, assignment_kind = assignment
            longitude, latitude = mesh_center(code)
            capacity = round(capacity * factor)
            if capacity <= 0:
                continue
            records.append({
                "id": f"jobs-500m-{code}", "meshCode": code,
                "longitude": longitude, "latitude": latitude,
                "jobs": capacity,
                "establishments": round(number(row.get("T001162001")) * factor),
                "prefCode": pref_code,
                "boundaryAssignment": assignment_kind,
            })
    return sorted(records, key=lambda record: record["meshCode"])


def cluster_sites(records: list[dict[str, Any]], radius_m: float) -> list[dict[str, Any]]:
    """Use the NEC maximal-radius seed rule, projected into metres for Japan."""
    forward = Transformer.from_crs("EPSG:4326", METRIC_CRS, always_xy=True)
    candidate_rows = []
    for record in records:
        x, y = forward.transform(record["longitude"], record["latitude"])
        candidate_rows.append({**record, "x": x, "y": y})
    candidates = sorted(candidate_rows, key=lambda row: (-row["commuters"], row["meshCode"]))
    seeds: list[dict[str, Any]] = []
    buckets: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    radius_squared = radius_m * radius_m
    for row in candidates:
        gx, gy = math.floor(row["x"] / radius_m), math.floor(row["y"] / radius_m)
        covered = any(
            (row["x"] - seed["x"]) ** 2 + (row["y"] - seed["y"]) ** 2 <= radius_squared
            for nx in range(gx - 1, gx + 2) for ny in range(gy - 1, gy + 2)
            for seed in buckets[(nx, ny)]
        )
        if not covered:
            seeds.append(row)
            buckets[(gx, gy)].append(row)
    members: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in candidate_rows:
        gx, gy = math.floor(row["x"] / radius_m), math.floor(row["y"] / radius_m)
        choices = [
            seed for nx in range(gx - 1, gx + 2) for ny in range(gy - 1, gy + 2)
            for seed in buckets[(nx, ny)]
            if (row["x"] - seed["x"]) ** 2 + (row["y"] - seed["y"]) ** 2 <= radius_squared
        ]
        if not choices:
            raise AssertionError(f"Seed set failed to cover {row['meshCode']}")
        seed = min(choices, key=lambda item: ((row["x"] - item["x"]) ** 2 + (row["y"] - item["y"]) ** 2, item["meshCode"]))
        members[seed["meshCode"]].append(row)
    sites = []
    for seed in seeds:
        grouped = members[seed["meshCode"]]
        total = sum(row["commuters"] for row in grouped)
        sites.append({
            "id": f"tokyo-kanagawa-site-{seed['meshCode']}",
            "seedMeshCode": seed["meshCode"],
            "longitude": sum(row["longitude"] * row["commuters"] for row in grouped) / total,
            "latitude": sum(row["latitude"] * row["commuters"] for row in grouped) / total,
            "commuters": total,
            "workers": sum(row["workers"] for row in grouped),
            "students": sum(row["students"] for row in grouped),
            "railUsers": sum(row["railUsers"] for row in grouped),
            "sourceCellCount": len(grouped),
            "prefCode": seed["prefCode"],
        })
    return sorted(sites, key=lambda site: site["id"])


MUNICIPALITY = re.compile(r"^(\d{5})_")


def read_municipality_od() -> list[dict[str, Any]]:
    """Extract observed Tokyo/Kanagawa municipality O/Ds from Census Table 6-1."""
    workbook_path = RAW / "2020-census-table-6-1-municipality-od-combined.xlsx"
    sheet = load_workbook(workbook_path, read_only=True, data_only=True).active
    header = next(sheet.iter_rows(min_row=8, max_row=8, values_only=True))
    destinations = []
    for index, value in enumerate(header):
        match = MUNICIPALITY.match(str(value or ""))
        # Codes ending in 00 are prefecture/designated-city aggregates.  Keep
        # the atomic municipalities and wards so totals are not double-counted.
        if match and match.group(1)[:2] in PREFECTURES and not match.group(1).endswith("00"):
            destinations.append((index, match.group(1), str(value).split("_", 1)[1]))
    flows = []
    for row in sheet.iter_rows(min_row=10, values_only=True):
        origin = str(row[3] or "")
        match = MUNICIPALITY.match(origin)
        if row[0] != "0_総数" or not match or match.group(1)[:2] not in PREFECTURES or match.group(1).endswith("00"):
            continue
        origin_code = match.group(1)
        origin_name = origin.split("_", 1)[1]
        for index, destination_code, destination_name in destinations:
            mass = number(row[index])
            if mass:
                flows.append({
                    "originMunicipalityCode": origin_code, "originName": origin_name,
                    "destinationMunicipalityCode": destination_code, "destinationName": destination_name,
                    "commutersAndStudents": mass,
                    "crossPrefecture": origin_code[:2] != destination_code[:2],
                })
    return sorted(flows, key=lambda flow: (flow["originMunicipalityCode"], flow["destinationMunicipalityCode"]))


def point_collection(records: list[dict[str, Any]], properties: tuple[str, ...]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {key: record[key] for key in properties},
         "geometry": {"type": "Point", "coordinates": [round(record["longitude"], 7), round(record["latitude"], 7)]}}
        for record in records
    ]}


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-radius-m", type=float, default=350, help="NEC-style Voronoi seed coverage radius in metres (default: 350)")
    args = parser.parse_args()
    if args.site_radius_m < 250:
        parser.error("site radius must be at least 250 m: smaller values out-resolve the source mesh")
    boundary_geojson, boundaries, boundary_index = load_test_boundary()
    selected_boundary = unary_union(list(boundaries.values()))
    homes = read_home_mesh(boundary_index, selected_boundary)
    jobs = read_job_mesh(boundary_index, selected_boundary)
    sites = sorted(
        (
            site
            for pref_code in PREFECTURES
            for site in cluster_sites([row for row in homes if row["prefCode"] == pref_code], args.site_radius_m)
        ),
        key=lambda site: site["id"],
    )
    od_flows = read_municipality_od()
    write_json(GENERATED / "world-boundary.geojson", boundary_geojson)
    write_json(GENERATED / "home-mesh-250m.geojson", point_collection(homes, ("id", "meshCode", "commuters", "workers", "students", "railUsers", "prefCode", "boundaryAssignment")))
    write_json(GENERATED / "job-mesh-500m.geojson", point_collection(jobs, ("id", "meshCode", "jobs", "establishments", "prefCode", "boundaryAssignment")))
    write_json(GENERATED / "voronoi-demand-sites.geojson", point_collection(sites, ("id", "seedMeshCode", "commuters", "workers", "students", "railUsers", "sourceCellCount", "prefCode")))
    write_json(GENERATED / "municipality-od.json", {"schemaVersion": 1, "source": "e-Stat 2020 Census Table 6-1", "flows": od_flows})
    cross_prefecture = sum(flow["commutersAndStudents"] for flow in od_flows if flow["crossPrefecture"])
    summary = {
        "schemaVersion": 1,
        "prototype": True,
        "generatedAt": datetime.now(UTC).isoformat(),
        "worldId": "JP_TOKYO_KANAGAWA_TEST",
        "prefectures": PREFECTURES,
        "areaKm2": round(sum(feature["properties"]["area_km2"] for feature in boundary_geojson["features"]), 2),
        "sources": {
            "homeDemand": "2020 Census T001109, 250 m mesh; T001109086 residents aged 15+ who work or study",
            "jobCapacity": "2021 Economic Census T001162, 500 m mesh; T001162022 all-industry employees",
            "observedOd": "2020 Census Table 6-1, municipality residence-to-work/school-place matrix",
        },
        "voronoi": {
            "algorithm": "NEC deterministic maximal-radius seed set, then weighted-centroid demand sites",
            "sourceMeshM": 250,
            "siteRadiusM": args.site_radius_m,
            "siteCount": len(sites),
            "medianSourceCellsPerSite": statistics.median(site["sourceCellCount"] for site in sites),
        },
        "homeMesh": {"cellCount": len(homes), "commuters": sum(row["commuters"] for row in homes), "workers": sum(row["workers"] for row in homes), "students": sum(row["students"] for row in homes)},
        "jobMesh": {"cellCount": len(jobs), "jobs": sum(row["jobs"] for row in jobs)},
        "municipalityOd": {"flowCount": len(od_flows), "withinTestWorldMass": sum(flow["commutersAndStudents"] for flow in od_flows), "crossPrefectureMass": cross_prefecture},
        "boundaryAssignment": {
            "homeCoastalWaterCentroids": sum(row["boundaryAssignment"] == "coastal-water-centroid" for row in homes),
            "jobCoastalWaterCentroids": sum(row["boundaryAssignment"] == "coastal-water-centroid" for row in jobs),
            "homeNeighborBorderFractions": sum(row["boundaryAssignment"] == "neighbor-prefecture-border-fraction" for row in homes),
            "jobNeighborBorderFractions": sum(row["boundaryAssignment"] == "neighbor-prefecture-border-fraction" for row in jobs),
        },
        "limitations": ["Municipality O/D totals are observed; assignment from mesh sites to destination buildings remains synthetic.", "Tokyo island geography is retained in the statistical boundary; build a separate far-island streaming tile before producing the road/asset world."],
    }
    write_json(GENERATED / "test-world.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
