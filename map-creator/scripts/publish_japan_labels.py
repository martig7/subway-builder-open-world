"""Publish source-backed Latin labels with Japanese fallback; never touch demand.

The audited lookup is matched geographically at every zoom. Numbered address
labels are removed. Unmatched/ambiguous readings retain the original name.
Original archives are retained in a caller-selected backup directory.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
from functools import lru_cache
import gzip
import hashlib
import json
import math
import mmap
from pathlib import Path
import shutil
import time

from audit_japan_labels import address, digest, emit, kana, latin

VERSION = "japan-source-romaji-v2"


class LabelLookup:
    def __init__(self, matches):
        from pykakasi import kakasi
        self.converter = kakasi()
        self.index = defaultdict(list)
        self.dispositions = Counter()
        with gzip.open(matches, "rt", encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                category, name = row["category"], row["name"]
                self.dispositions[category] += 1
                if category == "excludedAddress":
                    continue
                match = row.get("match") or {}
                text = name
                if category in {"sourceRomanized", "sourceEnglish", "alreadyLatin"}:
                    text = match.get("value", name)
                    if not latin(text):
                        raise ValueError(f"Invalid audited Latin name: {text}")
                elif category in {"sourceKana", "kanaName"}:
                    reading = match.get("value", name)
                    if not kana(reading):
                        raise ValueError(f"Refusing to guess kanji pronunciation: {reading}")
                    text = self.romanize_kana(reading)
                x = (row["lon"] + 180) / 360
                y = (1 - math.asinh(math.tan(math.radians(row["lat"]))) / math.pi) / 2
                self.index[(row["layer"], name)].append((x, y, text))

    @lru_cache(maxsize=10000)
    def romanize_kana(self, reading):
        text = "".join(part["hepburn"] for part in self.converter.convert(reading))
        if not latin(text):
            raise ValueError(f"Kana conversion did not produce Latin text: {reading}")
        return text[:1].upper() + text[1:]

    def name(self, layer, original, x, y, scale):
        # Tile quantization can move a point up to one grid unit per axis.
        choices = {text for sx, sy, text in self.index.get((layer, original), [])
                   if abs(sx - x) * scale <= 1.01 and abs(sy - y) * scale <= 1.01}
        return choices.pop() if len(choices) == 1 else original


@contextmanager
def archive(path):
    from pmtiles.reader import Reader, all_tiles
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        get_bytes = lambda offset, length: mapped[offset:offset + length]
        reader = Reader(get_bytes)
        yield reader, all_tiles(get_bytes)


def display_name(layer, feature, props, zxy, lookup):
    name = props.get("name", "")
    if address(name):
        return None
    geometry = feature.geometry
    if feature.type != 1 or not geometry or (geometry[0] & 7) != 1 or len(geometry) != 1 + 2 * (geometry[0] >> 3):
        raise ValueError("Expected point or multipoint label")
    z, x, y = zxy
    px = py = 0
    choices = set()
    for index in range(1, len(geometry), 2):
        dx, dy = [(v >> 1) ^ -(v & 1) for v in geometry[index:index + 2]]
        px += dx
        py += dy
        gx, gy = (x + px / layer.extent) / 2**z, (y + py / layer.extent) / 2**z
        choices.add(lookup.name(layer.name, name, gx, gy, layer.extent * 2**z))
    # Low-zoom context tiles may combine world-wrap copies into one feature.
    # Preserve its geometry and original spelling if constituent names disagree.
    text = choices.pop() if len(choices) == 1 else name
    # Source readings can reveal subdivisions hidden by abbreviated Japanese
    # names, e.g. 緑町1 -> Midoricho 1-chome. Exclude these too.
    return None if address(text) else text


def transform(raw, zxy, lookup, counts):
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    if b"labels" not in raw:
        return raw
    tile = vector_tile_pb2.tile()
    tile.ParseFromString(raw)
    z, x, y = zxy
    for layer in tile.layers:
        if not layer.name.endswith("labels"):
            continue
        original = type(layer)()
        original.CopyFrom(layer)
        layer.ClearField("features")
        layer.ClearField("values")
        layer.ClearField("keys")
        values, keys = {}, {}
        for feature in original.features:
            tags = list(zip(feature.tags[::2], feature.tags[1::2]))
            props = {original.keys[k]: original.values[v].string_value for k, v in tags}
            name = props.get("name", "")
            text = display_name(layer, feature, props, zxy, lookup)
            if text is None:
                counts["removedAddressOccurrences"] += 1
                continue
            counts["changedLabelOccurrences" if text != name else "unchangedLabelOccurrences"] += 1
            output = layer.features.add()
            output.CopyFrom(feature)
            output.ClearField("tags")
            for k, v in tags:
                key = original.keys[k]
                value = type(original.values[v])()
                value.CopyFrom(original.values[v])
                if key == "name":
                    value.Clear()
                    value.string_value = text
                if key not in keys:
                    keys[key] = len(layer.keys)
                    layer.keys.append(key)
                encoded = value.SerializeToString()
                if encoded not in values:
                    values[encoded] = len(layer.values)
                    layer.values.add().CopyFrom(value)
                output.tags.extend((keys[key], values[encoded]))
    return tile.SerializeToString()


def invariants(raw, removing_addresses, zxy=None, lookup=None):
    """Independent signature: exact non-label layers + surviving label geometry.

Ignores display-name text and removed address features, nothing else.
"""
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    tile = vector_tile_pb2.tile()
    tile.ParseFromString(raw)
    signature = hashlib.sha256()
    def add(data):
        signature.update(len(data).to_bytes(8, "little"))
        signature.update(data)
    for layer in tile.layers:
        if not layer.name.endswith("labels"):
            add(layer.SerializeToString())
        else:
            add(layer.name.encode())
            add(str((layer.version, layer.extent)).encode())
            for feature in layer.features:
                props = {layer.keys[k]: layer.values[v].string_value for k, v in zip(feature.tags[::2], feature.tags[1::2])}
                excluded = address(props.get("name", ""))
                if removing_addresses and lookup is not None:
                    excluded = display_name(layer, feature, props, zxy, lookup) is None
                if excluded:
                    if not removing_addresses:
                        raise AssertionError("Published address label remains")
                    continue
                clone = type(feature)()
                clone.CopyFrom(feature)
                clone.ClearField("tags")
                add(clone.SerializeToString())
                for k, v in zip(feature.tags[::2], feature.tags[1::2]):
                    if layer.keys[k] != "name":
                        add(layer.keys[k].encode())
                        add(layer.values[v].SerializeToString())
    return signature.digest()


def publish(path, backup, lookup, matches_hash, name):
    from pmtiles.writer import Writer
    from pmtiles.tile import Compression, zxy_to_tileid
    started = time.monotonic()
    counts = Counter()
    source_hash = digest(path)
    staged = path.with_suffix(".labels-staged")
    expected = {}
    with archive(path) as (reader, tiles):
        header, metadata = reader.header(), reader.metadata()
        if metadata.get("labelPolicy") == VERSION and metadata.get("labelMatchesSha256") == matches_hash:
            return {"sha256": source_hash, "resumed": True, "version": VERSION}
        if metadata.get("labelPolicy"):
            raise ValueError("Reapply changed policy to original backup, not already relabeled data")
        if backup.exists():
            raise FileExistsError(f"Refusing to overwrite original backup: {backup}")
        compression = header["tile_compression"]
        if compression not in (Compression.GZIP, Compression.NONE):
            raise ValueError("Unsupported PMTiles compression")
        with staged.open("wb") as output:
            writer = Writer(output)
            try:
                for zxy, data in tiles:
                    raw = gzip.decompress(data) if compression == Compression.GZIP else data
                    result = transform(raw, zxy, lookup, counts)
                    expected[zxy] = invariants(raw, True, zxy, lookup)
                    encoded = data if result == raw else (gzip.compress(result, compresslevel=6, mtime=0) if compression == Compression.GZIP else result)
                    writer.write_tile(zxy_to_tileid(*zxy), encoded)
                metadata.pop("tilestats", None)
                metadata.update(name=f"{name} Basemap", labelPolicy=VERSION, labelMatchesSha256=matches_hash)
                writer.finalize(header, metadata)
            finally:
                writer.tile_f.close()
    # Verify every tile after reading the written archive back from disk.
    with archive(staged) as (reader, tiles):
        if reader.metadata().get("labelPolicy") != VERSION:
            raise AssertionError("Missing publication marker")
        for zxy, data in tiles:
            raw = gzip.decompress(data) if compression == Compression.GZIP else data
            if invariants(raw, False) != expected.pop(zxy):
                raise AssertionError(f"Non-label content or label positions changed: {zxy}")
            counts["verifiedTiles"] += 1
        if expected:
            raise AssertionError("Missing output tiles")
    backup.parent.mkdir(parents=True, exist_ok=True)
    path.rename(backup)
    try:
        staged.rename(path)
    except BaseException:
        backup.rename(path)
        raise
    return {"version": VERSION, "sourceSha256": source_hash, "sha256": digest(path),
            "matchesSha256": matches_hash, "seconds": round(time.monotonic() - started, 2), **counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maps-root", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--definition", type=Path, required=True)
    parser.add_argument("--sources-root", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--tile", action="append", default=[])
    args = parser.parse_args()
    definition = json.loads(args.definition.read_text(encoding="utf-8"))
    matches = (args.sources_root / definition["matches"]).resolve()
    if not matches.is_relative_to(args.sources_root.resolve()):
        raise ValueError("Matches path escapes sources root")
    matches_hash = digest(matches)
    if definition["policyVersion"] != VERSION or matches_hash != definition["matchesSha256"]:
        raise ValueError("Label evidence/version does not match pinned definition")
    lookup = LabelLookup(matches)
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    selected = [t for t in catalog["tiles"] if t.get("status") == "selected"]
    if set(args.tile) - {t["id"] for t in selected}:
        raise ValueError("Unknown tile selection")
    for tile in selected:
        if args.tile and tile["id"] not in args.tile:
            continue
        root = args.maps_root / "tiles" / tile["id"]
        emit(stage=VERSION, status="started", tile=tile["id"])
        path = root / "tiles.pmtiles"
        report = publish(path, args.backup_root / tile["id"] / path.name, lookup, matches_hash, tile["name"])
        city = root / "tiles.city-only.pmtiles"
        if city.exists():
            if digest(city) == report.get("sourceSha256"):
                backup = args.backup_root / tile["id"] / city.name
                if backup.exists():
                    raise FileExistsError(backup)
                city.rename(backup)
                shutil.copyfile(path, city)
            else:
                publish(city, args.backup_root / tile["id"] / city.name, lookup, matches_hash, tile["name"])
        manifest_path = root / "map-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(labelPolicy=VERSION, labelMatchesSha256=matches_hash)
        for asset in manifest["assets"]:
            if asset["path"] == "tiles.pmtiles":
                asset.update(sha256=report["sha256"], bytes=path.stat().st_size)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if not report.get("resumed"):
            (root / "label-publication.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        emit(stage=VERSION, status="complete", tile=tile["id"], **report)


if __name__ == "__main__":
    main()
