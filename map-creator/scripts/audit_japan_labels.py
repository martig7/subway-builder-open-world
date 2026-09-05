"""Read-only label coverage audit. Outputs reports, never modifies map packages.

Extract original OSM place nodes on any runner, inventory existing PMTiles
locally, then match by normalized name AND distance. No kanji reading guesses.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
import mmap
from pathlib import Path
import re
import time
import unicodedata

NUMBER = r"[0-9〇零一二三四五六七八九十百千万壱弐参]+"
ADDRESS = re.compile(
    rf"(?:{NUMBER}(?:丁目|番地?|号|街区|地割)(?:の?{NUMBER})?$|^第?{NUMBER}地割$|^{NUMBER}$)"
    r"|(?:\bblock\s*\d+\b|\b\d+[- ]?chome\b)", re.IGNORECASE
)
LAYER_PLACES = {
    "city_labels": {"city", "borough", "town"},
    "suburb_labels": {"suburb", "village"},
    "neighborhood_labels": {"neighbourhood", "hamlet", "quarter", "locality"},
}
LATIN_KEYS = ("name:ja-Latn", "name:ja_rm", "name:ja-latn", "name:latin", "name:en")
KANA_KEYS = ("name:ja_kana", "name:ja-Hira", "name:ja-Hrkt", "name:reading", "name:kana", "name:pronunciation")


def normalized(text):
    return unicodedata.normalize("NFKC", text).strip()


def address(name):
    return bool(ADDRESS.search(normalized(name)))


def latin(text):
    return bool(text.strip()) and any(c.isalpha() for c in text) and all(
        not c.isalpha() or "LATIN" in unicodedata.name(c, "") for c in text
    )


def kana(text):
    text = normalized(text)
    return bool(re.search(r"[ぁ-んァ-ヶ]", text)) and all(
        not c.isalpha() or "HIRAGANA" in unicodedata.name(c, "") or "KATAKANA" in unicodedata.name(c, "")
        or c == "ー" for c in text
    )


def reading(tags):
    for key in LATIN_KEYS:
        if latin(tags.get(key, "")):
            return ("sourceEnglish" if key == "name:en" else "sourceRomanized", key, tags[key])
    for key in KANA_KEYS:
        if kana(tags.get(key, "")):
            return ("sourceKana", key, tags[key])
    if latin(tags.get("name", "")):
        return ("alreadyLatin", "name", tags["name"])
    if kana(tags.get("name", "")):
        return ("kanaName", "name", tags["name"])
    return None


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def emit(**event):
    print(json.dumps(event, ensure_ascii=True), flush=True)


def extract(args):
    import osmium
    args.output.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(args.source):
        start = time.monotonic()
        output = args.output / f"source-{index:02}.jsonl.gz"
        emit(stage="osm", status="started", source=str(source))
        count = 0
        tag_counts = Counter()
        with gzip.open(output, "wt", encoding="utf-8") as stream:
            processor = osmium.FileProcessor(str(source), entities=osmium.osm.NODE).with_filter(osmium.filter.KeyFilter("place"))
            for node in processor:
                tags = dict(node.tags)
                if not tags.get("name") or not node.location.valid():
                    continue
                tag_counts.update(key for key in tags if "name" in key)
                stream.write(json.dumps({"id": node.id, "version": node.version, "lon": node.location.lon,
                                         "lat": node.location.lat, "tags": tags}, ensure_ascii=False) + "\n")
                count += 1
        report = {"source": str(source), "sourceSha256": digest(source), "placeNodes": count,
                  "nameTagCounts": tag_counts, "seconds": round(time.monotonic() - start, 2)}
        output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        emit(stage="osm", status="complete", **report)


def inventory(args):
    from pmtiles.reader import Reader, all_tiles
    from pmtiles.tile import Compression
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    labels = {}
    for tile in catalog["tiles"]:
        if tile.get("status") != "selected":
            continue
        start = time.monotonic()
        path = args.maps_root / "tiles" / tile["id"] / "tiles.pmtiles"
        count = 0
        with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            get_bytes = lambda offset, length: mapped[offset:offset + length]
            header = Reader(get_bytes).header()
            if header["tile_compression"] not in (Compression.GZIP, Compression.NONE):
                raise ValueError("Unsupported tile compression")
            for (z, x, y), data in all_tiles(get_bytes):
                # All label layers persist to maxzoom. This avoids counting each
                # zoom separately, and gives the finest available coordinates.
                if z != header["max_zoom"]:
                    continue
                raw = gzip.decompress(data) if header["tile_compression"] == Compression.GZIP else data
                if b"labels" not in raw:
                    continue
                message = vector_tile_pb2.tile()
                message.ParseFromString(raw)
                for layer in message.layers:
                    if not layer.name.endswith("labels"):
                        continue
                    if layer.name not in LAYER_PLACES:
                        raise ValueError(f"Unaccounted label layer: {layer.name}")
                    for feature in layer.features:
                        props = {layer.keys[k]: layer.values[v].string_value for k, v in zip(feature.tags[::2], feature.tags[1::2])}
                        name = props.get("name", "")
                        if not name:
                            continue
                        geometry = feature.geometry
                        if feature.type != 1 or len(geometry) != 3 or geometry[0] != 9:
                            raise ValueError("Expected single point label geometry")
                        dx, dy = [(value >> 1) ^ -(value & 1) for value in geometry[1:]]
                        gx, gy = (x + dx / layer.extent) / 2**z, (y + dy / layer.extent) / 2**z
                        # Global quantized Mercator positions are identical in
                        # adjacent buffered tiles and overlapping prefecture maps.
                        key = (layer.name, name, round(gx, 12), round(gy, 12))
                        if key not in labels:
                            labels[key] = {"name": name, "layer": layer.name, "lon": gx * 360 - 180,
                                           "lat": math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy)))), "tiles": []}
                        if tile["id"] not in labels[key]["tiles"]:
                            labels[key]["tiles"].append(tile["id"])
                        count += 1
        emit(stage="tiles", tile=tile["id"], occurrences=count, uniqueSoFar=len(labels), seconds=round(time.monotonic() - start, 2))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output, "wt", encoding="utf-8") as stream:
        for value in labels.values():
            stream.write(json.dumps(value, ensure_ascii=False) + "\n")
    emit(stage="tiles", status="complete", uniqueLabels=len(labels))


def distance(a, b):
    dx = math.radians(a["lon"] - b["lon"]) * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    dy = math.radians(a["lat"] - b["lat"])
    return math.hypot(dx, dy) * 6371008.8


def compare(args):
    args.output.mkdir(parents=True, exist_ok=True)
    index = defaultdict(list)
    for path in sorted(args.sources.glob("source-*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            for line in stream:
                node = json.loads(line)
                node["source"] = path.name
                index[normalized(node["tags"]["name"])].append(node)
    counts, by_layer, by_tile = Counter(), defaultdict(Counter), defaultdict(Counter)
    missing_names, field_counts, excluded_names = set(), Counter(), set()
    with gzip.open(args.inventory, "rt", encoding="utf-8") as source, gzip.open(args.output / "matches.jsonl.gz", "wt", encoding="utf-8") as output:
        for line in source:
            label = json.loads(line)
            candidates = [(distance(label, n), n) for n in index.get(normalized(label["name"]), [])]
            candidates = [(d, n) for d, n in candidates if d <= 30 and n["tags"].get("place") in LAYER_PLACES[label["layer"]]]
            candidates.sort(key=lambda pair: pair[0])
            category, match = None, None
            if address(label["name"]):
                category = "excludedAddress"
                excluded_names.add(label["name"])
            elif candidates:
                # Resolve by OSM identity; never trust a name-only national join.
                closest = candidates[0][0]
                candidates = [(d, n) for d, n in candidates if d <= closest + 2]
                ids = {n["id"] for _, n in candidates}
                if len(ids) != 1:
                    category = "ambiguousMatch"
                else:
                    available = [(reading(n["tags"]), d, n) for d, n in candidates if reading(n["tags"])]
                    # Multiple snapshots are expected; report changed source
                    # readings instead of silently picking an arbitrary version.
                    variants = {(r[0], normalized(r[2]).casefold()) for r, _, _ in available}
                    if len(variants) > 1:
                        category = "conflictingReadings"
                    elif available:
                        r, d, node = available[0]
                        category = r[0]
                        match = {"osmNodeId": node["id"], "source": node["source"], "distanceM": round(d, 3), "field": r[1], "value": r[2]}
                        field_counts[r[1]] += 1
                    else:
                        category = "missingReading"
                        match = {"osmNodeId": candidates[0][1]["id"], "distanceM": round(closest, 3)}
            elif latin(label["name"]):
                category = "alreadyLatin"
            elif kana(label["name"]):
                category = "kanaName"
            else:
                category = "unmatchedSource"
            counts[category] += 1
            by_layer[label["layer"]][category] += 1
            for tile in label["tiles"]:
                by_tile[tile][category] += 1
            if category in {"missingReading", "unmatchedSource", "ambiguousMatch", "conflictingReadings"}:
                missing_names.add(label["name"])
            output.write(json.dumps({**label, "category": category, "match": match}, ensure_ascii=False) + "\n")
    summary = {"counts": counts, "uniqueLocations": sum(counts.values()), "distinctMissingNames": len(missing_names),
               "distinctExcludedNames": len(excluded_names), "byLayer": by_layer, "byTile": by_tile, "recoveredFields": field_counts,
               "matchingRadiusM": 30, "ambiguousDistanceToleranceM": 2,
               "note": "OSM supplied readings are recoverable candidates, not independently verified official spellings. Counts deduplicate tile halos and zooms, not different geographic locations."}
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output / "missing-names.json").write_text(json.dumps(sorted(missing_names), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    emit(stage="audit", **summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("extract")
    command.add_argument("--source", type=Path, action="append", required=True)
    command.add_argument("--output", type=Path, required=True)
    command = commands.add_parser("inventory")
    command.add_argument("--maps-root", type=Path, required=True)
    command.add_argument("--catalog", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    command = commands.add_parser("compare")
    command.add_argument("--inventory", type=Path, required=True)
    command.add_argument("--sources", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    {"extract": extract, "inventory": inventory, "compare": compare}[args.command](args)


if __name__ == "__main__":
    main()
