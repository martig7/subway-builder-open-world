from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

from .util import sha256_file, write_json


STATIC_FILES = (
    "buildings_index.bin.gz",
    "roads.geojson.gz",
    "runways_taxiways.geojson.gz",
    "tiles.pmtiles",
)
PACKAGE_FILES = (
    "demand_data.json.gz",
    "cross_commutes.json",
    *STATIC_FILES,
)
ACTIVE_PACKAGE_BUDGET = 512 * 2**20
INSTALLED_STATE_BUDGET = 12 * 2**30
PIPELINE_MEMORY_BUDGET = 16 * 2**30
WARM_SWITCH_BUDGET_SECONDS = 5.0


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def _asset(path: Path) -> dict[str, Any]:
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def _finalize_manifest(tile: dict[str, Any], tile_dir: Path) -> dict[str, Any]:
    missing = [name for name in PACKAGE_FILES if not (tile_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"{tile['id']} package is incomplete: {', '.join(missing)}")
    assets = [_asset(tile_dir / name) for name in PACKAGE_FILES]
    by_name = {item["path"]: item for item in assets}
    manifest = {
        "schemaVersion": 1,
        "tileId": tile["id"],
        "cityCode": tile.get("gameCityCode", tile["id"]),
        "city": {
            "name": tile["cityName"],
            "code": tile.get("gameCityCode", tile["id"]),
            "description": tile["description"],
            "population": tile.get("population", 0),
            "initialViewState": tile["initialViewState"],
        },
        "viewport": tile["initialViewState"],
        "dataFiles": {
            "demandData": "demand_data.json.gz",
            "buildingsIndex": "buildings_index.bin.gz",
            "roads": "roads.geojson.gz",
            "runwaysTaxiways": "runways_taxiways.geojson.gz",
        },
        "runtimeFiles": {
            "schemaVersion": 1,
            "crossCommutes": {**by_name["cross_commutes.json"], "encoding": "json"},
        },
        "vectorTiles": {"path": "tiles.pmtiles", "maxZoom": 15},
        "assets": assets,
    }
    write_json(tile_dir / "manifest.json", manifest)
    return manifest


def _stream_inflate(path: Path) -> int:
    total = 0
    with gzip.open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
    return total


def _geojson_feature_count(path: Path) -> int:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return len(json.load(source).get("features", []))


def _switch_load_proxy(tile_dir: Path) -> dict[str, Any]:
    started = time.perf_counter()
    manifest = _load(tile_dir / "manifest.json")
    demand_started = time.perf_counter()
    with gzip.open(tile_dir / "demand_data.json.gz", "rt", encoding="utf-8") as source:
        demand = json.load(source)
    demand_seconds = time.perf_counter() - demand_started
    roads_started = time.perf_counter()
    with gzip.open(tile_dir / "roads.geojson.gz", "rt", encoding="utf-8") as source:
        roads = json.load(source)
    roads_seconds = time.perf_counter() - roads_started
    inflate_started = time.perf_counter()
    buildings_bytes = _stream_inflate(tile_dir / "buildings_index.bin.gz")
    runways_bytes = _stream_inflate(tile_dir / "runways_taxiways.geojson.gz")
    inflate_seconds = time.perf_counter() - inflate_started
    with (tile_dir / "tiles.pmtiles").open("rb") as source:
        pmtiles_header = source.read(16_384)
    if not pmtiles_header:
        raise ValueError(f"empty PMTiles archive for {manifest['tileId']}")
    elapsed = time.perf_counter() - started
    return {
        "seconds": elapsed,
        "demandSeconds": demand_seconds,
        "roadsSeconds": roads_seconds,
        "binaryInflateSeconds": inflate_seconds,
        "cohorts": len(demand.get("pops", [])),
        "points": len(demand.get("points", [])),
        "roadFeatures": len(roads.get("features", [])),
        "inflatedBinaryBytes": buildings_bytes + runways_bytes,
    }


def _benchmark_switching(tile_ids: list[str], tiles_root: Path, repetitions: int = 3) -> dict[str, Any]:
    # Prime the OS cache once; timed samples represent the plan's warm-switch gate.
    for tile_id in tile_ids:
        _switch_load_proxy(tiles_root / tile_id)
    samples: list[dict[str, Any]] = []
    for _ in range(repetitions):
        for tile_id in tile_ids:
            sample = _switch_load_proxy(tiles_root / tile_id)
            samples.append({"tileId": tile_id, **{key: round(value, 6) if isinstance(value, float) else value for key, value in sample.items()}})
    times = [row["seconds"] for row in samples]
    return {
        "kind": "bounded-memory native-load proxy",
        "description": "parse demand and roads, stream-inflate building/runway data, and read the PMTiles header from the warm filesystem cache",
        "repetitions": repetitions,
        "samples": samples,
        "p50Seconds": round(statistics.median(times), 6),
        "p95Seconds": round(_percentile(times, 0.95), 6),
        "maxSeconds": round(max(times, default=0), 6),
    }


def _benchmark_day(tile_ids: list[str], tiles_root: Path) -> dict[str, Any]:
    started = time.perf_counter()
    cohorts = workers = generalized_cost_checksum = 0
    by_tile = []
    for tile_id in tile_ids:
        tile_started = time.perf_counter()
        with gzip.open(tiles_root / tile_id / "demand_data.json.gz", "rt", encoding="utf-8") as source:
            demand = json.load(source)
        tile_workers = 0
        for pop in demand.get("pops", []):
            mass = int(pop["size"])
            driving = int(pop.get("drivingSeconds", 0))
            tile_workers += mass
            generalized_cost_checksum = (generalized_cost_checksum + mass * max(60, driving)) % 2_147_483_647
        cohorts += len(demand.get("pops", []))
        workers += tile_workers
        by_tile.append({"tileId": tile_id, "cohorts": len(demand.get("pops", [])), "workers": tile_workers, "seconds": round(time.perf_counter() - tile_started, 6)})
    return {
        "kind": "one-day full-cohort traversal proxy",
        "cohorts": cohorts,
        "workers": workers,
        "generalizedCostChecksum": generalized_cost_checksum,
        "seconds": round(time.perf_counter() - started, 6),
        "tiles": by_tile,
    }


def _benchmark_saves(tile_ids: list[str], work_root: Path) -> dict[str, Any]:
    started = time.perf_counter()
    written = 0
    reclaimed = 0
    with tempfile.TemporaryDirectory(prefix="ny-pilot-save-", dir=work_root) as directory:
        root = Path(directory)
        retained: list[Path] = []
        for revision in range(11):
            payload = {
                "schemaVersion": 1,
                "revision": revision,
                "clock": {"day": revision + 1, "seconds": revision * 86400},
                "wallet": 1_000_000 + revision * 1234,
                "activeTileId": tile_ids[revision % len(tile_ids)],
                "tileSnapshots": {tile_id: {"blob": hashlib.sha256(f"{tile_id}:{revision // len(tile_ids)}".encode()).hexdigest()} for tile_id in tile_ids},
            }
            path = root / f"autosave-{revision:02d}.json"
            write_json(path, payload)
            written += path.stat().st_size
            retained.append(path)
            if len(retained) > 10:
                oldest = retained.pop(0)
                reclaimed += oldest.stat().st_size
                oldest.unlink()
        retained_bytes = sum(path.stat().st_size for path in retained)
        if len(retained) != 10:
            raise AssertionError("autosave retention exceeded ten manifests")
    return {
        "checkpointsWritten": 11,
        "checkpointsRetained": 10,
        "bytesWritten": written,
        "bytesRetained": retained_bytes,
        "bytesReclaimed": reclaimed,
        "seconds": round(time.perf_counter() - started, 6),
    }


def _density_projection(package_rows: list[dict[str, Any]], inventory: dict[str, Any]) -> dict[str, Any]:
    pilot_by_id = {row["tileId"]: row for row in package_rows}
    inventory_by_id = {row["tileId"]: row for row in inventory["tiles"]}
    pilots = []
    for tile_id, package in pilot_by_id.items():
        density = max(1e-9, float(inventory_by_id[tile_id]["activityWorkersPerStateKm2"]))
        pilots.append({**package, "activityWorkersPerStateKm2": density})
    assignments = []
    for tile in inventory["tiles"]:
        if tile["status"] != "normal":
            continue
        density = max(1e-9, float(tile["activityWorkersPerStateKm2"]))
        proxy = min(pilots, key=lambda row: abs(math.log(density) - math.log(row["activityWorkersPerStateKm2"])))
        assignments.append({
            "tileId": tile["tileId"],
            "activityWorkersPerStateKm2": round(density, 3),
            "proxyTileId": proxy["tileId"],
            "projectedBytes": proxy["packageBytes"],
            "projectedBuildSeconds": proxy["buildSeconds"],
        })
    projected_bytes = sum(row["projectedBytes"] for row in assignments)
    projected_build = sum(row["projectedBuildSeconds"] for row in assignments)
    return {
        "method": "nearest pilot by log activity-worker density; independent per-tile PMTiles retained (conservative versus a shared archive)",
        "normalTiles": len(assignments),
        "sliversExcluded": sum(1 for row in inventory["tiles"] if row["status"] == "sliver"),
        "projectedInstalledBytes": projected_bytes,
        "conservativeInstalledBytes": round(projected_bytes * 1.35),
        "projectedSerialBuildSeconds": round(projected_build, 3),
        "assignments": assignments,
    }


def benchmark_pilot(generated_dir: str | Path) -> dict[str, Any]:
    generated = Path(generated_dir)
    pilot = generated / "pilot"
    tiles_root = pilot / "tiles"
    reports = pilot / "reports"
    benchmarks = pilot / "benchmarks"
    reports.mkdir(parents=True, exist_ok=True)
    catalog = _load(generated / "catalog" / "tile-catalog.json")
    inventory = _load(generated / "reports" / "lodes-tile-inventory.json")
    demand_report = _load(reports / "pilot-demand.json")
    tile_ids = list(demand_report["pilotTiles"])
    catalog_by_id = {row["id"]: row for row in catalog["tiles"]}
    package_rows = []
    for tile_id in tile_ids:
        manifest = _finalize_manifest(catalog_by_id[tile_id], tiles_root / tile_id)
        depot = _load(benchmarks / f"{tile_id}.json")
        package_bytes = sum(int(asset["bytes"]) for asset in manifest["assets"])
        package_rows.append({
            "tileId": tile_id,
            "buildingFeatures": int(depot.get("buildingFeatures", 0)),
            "roadFeatures": int(depot.get("roadFeatures", 0)) or _geojson_feature_count(tiles_root / tile_id / "roads.geojson.gz"),
            "packageBytes": package_bytes,
            "buildSeconds": float(depot["elapsedSeconds"]),
            "peakRssBytes": int(depot["peakRssBytes"]),
            "assets": {asset["path"]: asset["bytes"] for asset in manifest["assets"]},
        })
    switching = _benchmark_switching(tile_ids, tiles_root)
    day = _benchmark_day(tile_ids, tiles_root)
    work_root = generated / "work"
    work_root.mkdir(parents=True, exist_ok=True)
    saves = _benchmark_saves(tile_ids, work_root)
    projection = _density_projection(package_rows, inventory)
    peak_memory = max(row["peakRssBytes"] for row in package_rows)
    max_package = max(row["packageBytes"] for row in package_rows)
    gates = {
        "installedSize": projection["conservativeInstalledBytes"] <= INSTALLED_STATE_BUDGET,
        "pipelineMemory": peak_memory <= PIPELINE_MEMORY_BUDGET,
        "activePackage": max_package <= ACTIVE_PACKAGE_BUDGET,
        "warmSwitch": switching["p95Seconds"] <= WARM_SWITCH_BUDGET_SECONDS,
    }
    routing_path = reports / "pilot-routing.json"
    report = {
        "schemaVersion": 1,
        "prototype": True,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {"lodesVintage": 2023, "osmExtractDate": "2026-08-10"},
        "budgets": {
            "installedBytes": INSTALLED_STATE_BUDGET,
            "pipelineMemoryBytes": PIPELINE_MEMORY_BUDGET,
            "activePackageBytes": ACTIVE_PACKAGE_BUDGET,
            "warmSwitchSeconds": WARM_SWITCH_BUDGET_SECONDS,
        },
        "packages": package_rows,
        "switching": switching,
        "save": saves,
        "oneDay": day,
        "routing": _load(routing_path) if routing_path.exists() else {"status": "not-run"},
        "projection": projection,
        "peakPipelineRssBytes": peak_memory,
        "largestPackageBytes": max_package,
        "gates": gates,
        "verdict": "PASS" if all(gates.values()) else "FAIL",
    }
    write_json(reports / "milestone2-feasibility.json", report)
    lines = [
        "# Milestone 2 — six-package density pilot",
        "",
        f"**{report['verdict']}** for the measured feasibility gates. This is a construction/load proxy, not an in-game renderer benchmark.",
        "",
        "## Measured packages",
        "",
        "| Tile | Buildings | Roads | Package MiB | Build min |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for row in package_rows:
        lines.append(f"| `{row['tileId']}` | {row['buildingFeatures']:,} | {row['roadFeatures']:,} | {row['packageBytes'] / 2**20:.1f} | {row['buildSeconds'] / 60:.1f} |")
    lines.extend([
        "",
        "## Gates",
        "",
        f"- Statewide installed projection: **{projection['projectedInstalledBytes'] / 2**30:.2f} GiB**; 35% conservative case **{projection['conservativeInstalledBytes'] / 2**30:.2f} GiB** / 12 GiB — **{'PASS' if gates['installedSize'] else 'FAIL'}**.",
        f"- Peak one-process pipeline RSS: **{peak_memory / 2**30:.2f} GiB** / 16 GiB — **{'PASS' if gates['pipelineMemory'] else 'FAIL'}**.",
        f"- Largest package: **{max_package / 2**20:.1f} MiB** / 512 MiB pilot active-package budget — **{'PASS' if gates['activePackage'] else 'FAIL'}**.",
        f"- Warm load-proxy p95: **{switching['p95Seconds']:.2f} s** / 5 s — **{'PASS' if gates['warmSwitch'] else 'FAIL'}**.",
        f"- One-day traversal: **{day['cohorts']:,} cohorts / {day['workers']:,} workers in {day['seconds']:.2f} s**.",
        f"- Ten-autosave retention: **{saves['checkpointsRetained']} retained after 11 writes**, {saves['bytesReclaimed']:,} bytes reclaimed.",
        "",
        "## Interpretation",
        "",
        "The statewide estimate assigns each normal tile to the closest measured pilot by log LODES activity-worker density. It retains an independent PMTiles archive per tile, so it is conservative relative to the planned shared archive. The warm-switch test performs the expensive immutable-data work (JSON parsing and gzip inflation) against a warm filesystem cache, but it does not measure Electron renderer reconstruction; that remains a Milestone 3 integration check.",
        "",
        f"Routing status: **{report['routing'].get('status', 'complete')}**.",
    ])
    (reports / "milestone2-feasibility.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return report
