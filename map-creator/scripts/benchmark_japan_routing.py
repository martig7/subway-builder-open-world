from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
import time
from pathlib import Path

import numpy as np

from open_world_map_creator.routing.generated_roads import build_road_graph


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def sampled_pairs(demand_root: Path, tile_id: str, sample_count: int):
    payload = read_gzip_json(demand_root / "tiles" / tile_id / "demand_data.json.gz")
    points = {str(point["id"]): tuple(map(float, point["location"])) for point in payload["points"]}
    pops = payload["pops"]
    if not pops:
        return []
    offsets = np.linspace(0, len(pops) - 1, min(sample_count, len(pops)), dtype=np.int64)
    result = []
    seen: set[tuple[str, str]] = set()
    for offset in offsets:
        pop = pops[int(offset)]
        pair = (str(pop["residenceId"]), str(pop["jobId"]))
        if pair in seen:
            continue
        seen.add(pair)
        result.append((points[pair[0]], points[pair[1]]))
    return result


def snapped_nodes(graph, pair):
    projected = np.asarray([graph.projected(*point) for point in pair], dtype=np.float64)
    _, snapped = graph._tree.query(projected, k=1)
    return int(snapped[0]), int(snapped[1])


def comparable(route):
    if route is None:
        return None
    return round(route[0]), round(route[1])


def percentile(values: list[float], fraction: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), fraction * 100))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare exact major-access hierarchy routes with baseline full-graph A*."
    )
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--maps-dir", required=True, type=Path)
    parser.add_argument("--demand-dir", required=True, type=Path)
    parser.add_argument("--samples-per-tile", type=int, default=10)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.samples_per_tile < 1:
        parser.error("--samples-per-tile must be positive")

    build_started = time.perf_counter()
    graph, graph_report = build_road_graph(
        args.catalog,
        args.maps_dir,
        prepare_major_access_hierarchy=True,
        progress=lambda message: print(message, flush=True),
    )
    build_seconds = time.perf_counter() - build_started
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    tile_ids = [str(tile["id"]) for tile in catalog["tiles"] if tile.get("status") == "selected"]

    baseline_durations: list[float] = []
    hierarchy_durations: list[float] = []
    mismatches: list[dict] = []
    samples = 0
    for tile_index, tile_id in enumerate(tile_ids, 1):
        tile_pairs = sampled_pairs(args.demand_dir, tile_id, args.samples_per_tile)
        tile_baseline = 0.0
        tile_hierarchy = 0.0
        for pair in tile_pairs:
            start, destination = snapped_nodes(graph, pair)
            started = time.perf_counter()
            baseline = graph._astar(start, destination)
            baseline_elapsed = time.perf_counter() - started
            started = time.perf_counter()
            hierarchical = graph._hierarchical_astar(start, destination)
            hierarchy_elapsed = time.perf_counter() - started
            baseline_durations.append(baseline_elapsed)
            hierarchy_durations.append(hierarchy_elapsed)
            tile_baseline += baseline_elapsed
            tile_hierarchy += hierarchy_elapsed
            samples += 1
            if comparable(baseline) != comparable(hierarchical):
                mismatches.append({
                    "tileId": tile_id,
                    "start": start,
                    "destination": destination,
                    "baseline": comparable(baseline),
                    "hierarchical": comparable(hierarchical),
                })
        speedup = tile_baseline / tile_hierarchy if tile_hierarchy else math.inf
        print(
            f"[routing-benchmark] {tile_index}/{len(tile_ids)} {tile_id} "
            f"{len(tile_pairs)} samples, {speedup:.2f}x",
            flush=True,
        )

    baseline_seconds = sum(baseline_durations)
    hierarchy_seconds = sum(hierarchy_durations)
    report = {
        "schemaVersion": 1,
        "sampleCount": samples,
        "mismatchCount": len(mismatches),
        "mismatches": mismatches[:20],
        "baselineSeconds": round(baseline_seconds, 6),
        "hierarchySeconds": round(hierarchy_seconds, 6),
        "querySpeedup": round(baseline_seconds / hierarchy_seconds, 4) if hierarchy_seconds else None,
        "baselineMedianMilliseconds": round(statistics.median(baseline_durations) * 1000, 4),
        "hierarchyMedianMilliseconds": round(statistics.median(hierarchy_durations) * 1000, 4),
        "baselineP95Milliseconds": round(percentile(baseline_durations, 0.95) * 1000, 4),
        "hierarchyP95Milliseconds": round(percentile(hierarchy_durations, 0.95) * 1000, 4),
        "graphBuildSeconds": round(build_seconds, 3),
        "graph": graph_report,
    }
    rendered = json.dumps(report, indent=2, sort_keys=True)
    print(rendered, flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8", newline="\n")
    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())
