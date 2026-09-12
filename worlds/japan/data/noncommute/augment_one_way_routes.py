#!/usr/bin/env python3
"""Append geometric route records for sampled one-way trips to Japan's pinned route archive.

Existing routed commuter records and bytes are copied unchanged. This avoids
claiming the new synthetic endpoints have OSRM routes when none were computed.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import struct
from collections import Counter
from pathlib import Path

HEADER = struct.Struct("<8sII")
ENTRY = struct.Struct("<16sQII")
MAGIC = b"OWRTIDX1"


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def read_gzip(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def validate_append_only(base: dict, augmented: dict) -> list[list]:
    for field in ("schemaVersion", "tileId", "pointFields", "drivingModel"):
        if base[field] != augmented[field]:
            raise ValueError(f"Changed baseline demand field: {field}")
    if augmented["popFields"] != base["popFields"] + ["tripType"]:
        raise ValueError("Expected only an appended tripType pop field")
    for field in ("points", "pops", "gateways"):
        if augmented[field][: len(base[field])] != base[field]:
            raise ValueError(f"Baseline {field} changed instead of being appended")
    new_pops = augmented["pops"][len(base["pops"]):]
    if not new_pops or any(len(pop) != len(augmented["popFields"]) or pop[-1] != "oneWay" for pop in new_pops):
        raise ValueError("Appended pops must all be typed one-way trips")
    return new_pops


def read_index(path: Path) -> list[tuple[bytes, int, int, int]]:
    data = path.read_bytes()
    if len(data) < HEADER.size:
        raise ValueError("Truncated route index")
    magic, version, count = HEADER.unpack_from(data)
    if magic != MAGIC or version != 1 or len(data) != HEADER.size + count * ENTRY.size:
        raise ValueError("Invalid route index")
    return [ENTRY.unpack_from(data, HEADER.size + index * ENTRY.size) for index in range(count)]


def augment(base_demand: Path, augmented_demand: Path, base_routes: Path, output: Path) -> dict:
    if output.resolve() == base_routes.resolve() or base_routes.resolve() in output.resolve().parents:
        raise ValueError("Route augmentation output must be outside the baseline route archive")
    source_manifest_path = base_routes / "route-geometry-manifest.json"
    manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    cross_report = manifest["packages"]["cross"]
    base_cross_path = base_demand if base_demand.is_file() else base_demand / "world" / "cross_demand.json.gz"
    new_cross_path = augmented_demand / "cross_demand.json.gz"
    if sha256(base_cross_path) != cross_report["demandSha256"]:
        raise ValueError("Existing route archive is not pinned to the baseline cross demand")
    base = read_gzip(base_cross_path)
    augmented = read_gzip(new_cross_path)
    pops = validate_append_only(base, augmented)
    source_index = base_routes / "cross" / "cross-driving-routes.idx"
    source_data = base_routes / "cross" / "cross-driving-routes.bin"
    for source in (source_index, source_data):
        asset = next(item for item in cross_report["assets"] if item["path"] == source.name)
        if source.stat().st_size != asset["bytes"] or sha256(source) != asset["sha256"]:
            raise ValueError(f"Original route asset changed: {source}")
    entries = read_index(source_index)
    if len(entries) != len(base["pops"]):
        raise ValueError("Existing route index does not match baseline pop count")
    original_keys = {hashlib.sha256(str(pop[0]).encode()).digest()[:16] for pop in base["pops"]}
    if {entry[0] for entry in entries} != original_keys:
        raise ValueError("Existing route index does not match baseline pop IDs")

    target = output / "cross"
    target.mkdir(parents=True, exist_ok=True)
    output_data = target / source_data.name
    output_index = target / source_index.name
    with source_data.open("rb") as source, output_data.open("wb") as output_stream:
        shutil.copyfileobj(source, output_stream, length=1024 * 1024)
        existing_keys = set(original_keys)
        payloads = {}
        for pop in pops:
            pop_id, _, origin_index, destination_index = pop[:4]
            key = hashlib.sha256(str(pop_id).encode()).digest()[:16]
            if key in existing_keys:
                raise ValueError(f"Duplicate one-way pop ID: {pop_id}")
            existing_keys.add(key)
            origin = augmented["points"][origin_index][1:3]
            destination = augmented["points"][destination_index][1:3]
            record = {"origin": origin, "destination": destination, "polyline": None,
                      "source": "geometric-no-road-route", "metres": pop[8], "seconds": pop[7]}
            raw = json.dumps(record, separators=(",", ":"), ensure_ascii=True).encode()
            payload_key = hashlib.sha256(raw).digest()
            if payload_key not in payloads:
                zipped = gzip.compress(raw, compresslevel=6, mtime=0)
                payloads[payload_key] = (output_stream.tell(), len(zipped))
                output_stream.write(zipped)
            offset, length = payloads[payload_key]
            entries.append((key, offset, length, 0))
    entries.sort(key=lambda entry: entry[0])
    with output_index.open("wb") as destination:
        destination.write(HEADER.pack(MAGIC, 1, len(entries)))
        for entry in entries:
            destination.write(ENTRY.pack(*entry))
    data_size = output_data.stat().st_size
    if any(offset + length > data_size for _, offset, length, _ in entries):
        raise ValueError("Route index points beyond archive data")
    sources = Counter(cross_report["sources"])
    sources["geometric-no-road-route"] += len(pops)
    new_report = {**cross_report, "demandSha256": sha256(new_cross_path),
                  "routes": len(entries), "uniqueRecords": cross_report["uniqueRecords"] + len(payloads),
                  "sources": dict(sources), "assets": [
                      {"path": asset.name, "bytes": asset.stat().st_size, "sha256": sha256(asset)}
                      for asset in (output_index, output_data)]}
    (target / "route-manifest.json").write_text(json.dumps(new_report, indent=2) + "\n", encoding="utf-8")
    manifest["packages"]["cross"] = new_report
    (output / "route-geometry-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = {"baseRouteCount": cross_report["routes"], "oneWayGeometricRoutes": len(pops),
              "augmentedRouteCount": len(entries), "baseDemandSha256": cross_report["demandSha256"],
              "augmentedDemandSha256": new_report["demandSha256"], "archiveBytes": data_size,
              "routeIndexSha256": sha256(output_index), "routeDataSha256": sha256(output_data)}
    (output / "augmentation-report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-demand", type=Path, required=True)
    parser.add_argument("--augmented-demand", type=Path, required=True)
    parser.add_argument("--base-routes", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(augment(arguments.base_demand, arguments.augmented_demand,
                             arguments.base_routes, arguments.output), indent=2))
