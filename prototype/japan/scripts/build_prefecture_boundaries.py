"""Compile e-Stat 2020 Census statistical boundaries into prefecture GeoJSON."""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
from shapely import union_all


SOURCE_ID = "A002005212020"
SOURCE_URL = (
    "https://www.e-stat.go.jp/gis/statmap-search/data"
    "?dlserveyId=A002005212020&code={code}&coordSys=1&format=shape"
    "&downloadType=5&datum=2000"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(raw_dir: Path, output: Path, manifest_path: Path, preview_path: Path) -> None:
    archives = sorted(raw_dir.glob("pref-*.zip"))
    if len(archives) != 47:
        raise ValueError(f"expected 47 prefecture archives, found {len(archives)}")

    records: list[dict[str, object]] = []
    geometries = []
    source_manifest: list[dict[str, object]] = []
    for archive in archives:
        code = archive.stem[-2:]
        with zipfile.ZipFile(archive) as zipped:
            shape_names = [name for name in zipped.namelist() if name.lower().endswith(".shp")]
        if len(shape_names) != 1:
            raise ValueError(f"{archive.name}: expected one Shapefile, found {shape_names}")

        frame = gpd.read_file(archive)
        if frame.crs is None:
            raise ValueError(f"{archive.name}: missing CRS in .prj")
        pref_codes = frame["PREF"].astype("string").str.zfill(2).dropna().unique().tolist()
        if pref_codes != [code]:
            raise ValueError(f"{archive.name}: expected only prefecture {code}, found {pref_codes}")

        # Union one prefecture at a time. Keeping the full national set in a
        # single GeoDataFrame makes GEOS use several gigabytes of memory.
        metric = frame.to_crs("EPSG:6933")
        metric["geometry"] = metric.geometry.make_valid()
        metric = metric[~metric.geometry.is_empty & metric.geometry.notna()]
        geometries.append(union_all(metric.geometry.array))
        records.append({
            "pref_code": code,
            "pref_name_ja": str(frame["PREF_NAME"].dropna().iloc[0]),
            "statistical_unit_count": int(len(metric)),
        })
        source_manifest.append({
            "pref_code": code,
            "filename": archive.name,
            "url": SOURCE_URL.format(code=code),
            "sha256": sha256(archive),
            "bytes": archive.stat().st_size,
            "survey_id": SOURCE_ID,
        })

    dissolved = gpd.GeoDataFrame(records, geometry=geometries, crs="EPSG:6933")
    dissolved = dissolved.set_index("pref_code")
    dissolved["tile_id"] = [f"JP_PREF_{code}" for code in dissolved.index]
    dissolved["area_km2"] = dissolved.geometry.area / 1_000_000
    dissolved["source"] = "e-Stat 2020 Census town/area statistical boundaries"
    dissolved["source_crs"] = "EPSG:4612 / JGD2000"

    output_frame = dissolved.reset_index().to_crs("EPSG:4326")
    output.parent.mkdir(parents=True, exist_ok=True)
    output_frame.to_file(output, driver="GeoJSON", encoding="UTF-8")

    # A small visual preview: close sub-kilometre statistical seams, then
    # simplify in metres. The exact output above remains untouched.
    preview_metric = dissolved.reset_index().copy()
    preview_metric["geometry"] = (
        preview_metric.geometry.buffer(1000).buffer(-1000)
        .simplify(5000, preserve_topology=False)
    )
    preview = preview_metric.to_crs("EPSG:4326")
    preview.to_file(preview_path, driver="GeoJSON", encoding="UTF-8")

    report = {
        "schema_version": "1.0.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "survey_id": SOURCE_ID,
            "survey": "2020 Census",
            "boundary": "町丁・字等 statistical boundaries",
            "source_crs": "EPSG:4612",
            "output_crs": "EPSG:4326",
        },
        "prefecture_count": len(output_frame),
        "statistical_unit_count": int(sum(item["statistical_unit_count"] for item in records)),
        "sources": source_manifest,
        "output": {
            "filename": output.name,
            "sha256": sha256(output),
            "bytes": output.stat().st_size,
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--preview", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    build(args.raw_dir, args.output, args.manifest, args.preview)


if __name__ == "__main__":
    main()
