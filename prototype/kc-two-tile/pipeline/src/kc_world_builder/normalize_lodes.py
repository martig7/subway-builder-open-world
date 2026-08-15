"""Streaming LODES crosswalk and OD normalization without dataframe loading."""
from __future__ import annotations

import csv
import gzip
import json
import sqlite3
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, TextIO

from .config import WorldConfig
from .util import iter_jsonl


def normalize_block(value: object) -> str:
    text = str(value).strip()
    if not text.isdigit() or len(text) > 15:
        raise ValueError(f"invalid Census block code {value!r}")
    return text.zfill(15)


@contextmanager
def open_lodes_csv(path: str | Path) -> Iterator[TextIO]:
    path = Path(path)
    with (gzip.open(path, "rt", encoding="utf-8", newline="") if path.suffix == ".gz" else path.open(encoding="utf-8", newline="")) as handle:
        yield handle


def build_crosswalk_index(crosswalk_files: list[str | Path], sqlite_path: str | Path, *, project_wgs84: bool = False) -> int:
    """Build a disk-backed index; only requested columns are retained."""
    transformer = None
    if project_wgs84:
        try:
            from pyproj import Transformer  # type: ignore[import-not-found]
        except ImportError as error:
            raise RuntimeError("WGS84 LODES crosswalks need pyproj: pip install pyproj") from error
        transformer = Transformer.from_crs("EPSG:4326", "EPSG:26915", always_xy=True)
    database = sqlite3.connect(sqlite_path)
    try:
        database.execute("CREATE TABLE IF NOT EXISTS blocks (block TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, county TEXT, tract TEXT)")
        count = 0
        for path in crosswalk_files:
            with open_lodes_csv(path) as handle:
                for row in csv.DictReader(handle):
                    block = normalize_block(row.get("tabblk2020") or row.get("tabblk2010") or row.get("w_geocode") or row.get("h_geocode") or row.get("block"))
                    # LODES crosswalks call these columns blklatdd/blklondd.
                    y, x = float(row.get("blklatdd") or row.get("lat") or row["y"]), float(row.get("blklondd") or row.get("lon") or row["x"])
                    if transformer is not None:
                        x, y = transformer.transform(x, y)
                    database.execute("INSERT OR REPLACE INTO blocks VALUES (?, ?, ?, ?, ?)", (block, x, y, row.get("cty"), row.get("trct") or row.get("tract")))
                    count += 1
            database.commit()
        return count
    finally:
        database.close()


def _iter_od(path: Path) -> Iterator[dict[str, str]]:
    with open_lodes_csv(path) as handle:
        yield from csv.DictReader(handle)


def normalize_od_files(
    config: WorldConfig,
    crosswalk_index: str | Path,
    sources: list[tuple[str, str, str | Path]],
    output_jsonl: str | Path,
) -> dict[str, object]:
    """Write canonical OD JSONL. `sources` is (state, main|aux, filename).

    Coordinates are assumed to have been projected to the config CRS by the
    caller/crosswalk preparation step. Production crosswalk ingestion should
    project WGS84 before this function; fixtures may already use metric coords.
    """
    database = sqlite3.connect(crosswalk_index)
    output_jsonl = Path(output_jsonl)
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    totals: Counter[str] = Counter()
    try:
        with output_jsonl.open("w", encoding="utf-8", newline="\n") as output:
            for state, kind, filename in sources:
                if kind not in {"main", "aux"}:
                    raise ValueError("LODES file kind must be main or aux")
                for row in _iter_od(Path(filename)):
                    residence = normalize_block(row.get("h_geocode"))
                    workplace = normalize_block(row.get("w_geocode"))
                    mass = int(row.get("S000", "0"))
                    if mass < 0:
                        raise ValueError("S000 may not be negative")
                    totals["input_mass"] += mass
                    # `main` and `aux` are distinct official inputs. Do not
                    # deduplicate equal-looking rows here: aggregation happens
                    # after provenance has been retained by this streaming step.
                    home = database.execute("SELECT x,y FROM blocks WHERE block=?", (residence,)).fetchone()
                    job = database.execute("SELECT x,y FROM blocks WHERE block=?", (workplace,)).fetchone()
                    if home is None or job is None:
                        totals["missing_crosswalk_mass"] += mass
                        continue
                    home_kind, _ = config.location_kind(*home)
                    job_kind, _ = config.location_kind(*job)
                    # Halo membership controls immutable map-data inclusion,
                    # not simulation ownership. Demand endpoints must be inside
                    # an ownership tile; perimeter halos have no gateway model
                    # in this two-tile internal-seam prototype.
                    home_tile = config.owner_of(*home)
                    job_tile = config.owner_of(*job)
                    # The two-tile test has gateways only on the internal seam.
                    # Retain pairs owned by both prototype tiles; national builds
                    # will replace this corridor filter with the full tile index.
                    if home_tile is None or job_tile is None:
                        totals["outside_corridor_mass"] += mass
                        continue
                    record = {"home_block": residence, "work_block": workplace, "S000": mass, "source_state": state, "source_kind": kind, "source_vintage": config.data_vintage,
                              "home_x": home[0], "home_y": home[1], "work_x": job[0], "work_y": job[1], "home_location": home_kind, "home_tile": home_tile, "work_location": job_kind, "work_tile": job_tile}
                    output.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
                    totals["normalized_mass"] += mass
                    totals[f"{state}_{kind}_mass"] += mass
    finally:
        database.close()
    return dict(totals)


def write_parquet_from_jsonl(jsonl_path: str | Path, parquet_path: str | Path, *, batch_size: int = 50_000) -> None:
    try:
        import pyarrow as pa  # type: ignore[import-not-found]
        import pyarrow.parquet as pq  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError("Parquet output needs the optional dependency: pip install -e '.[parquet]'") from error
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    writer = None
    batch: list[dict[str, object]] = []
    try:
        for row in iter_jsonl(Path(jsonl_path)):
            batch.append(row)
            if len(batch) == batch_size:
                table = pa.Table.from_pylist(batch)
                writer = writer or pq.ParquetWriter(parquet_path, table.schema)
                writer.write_table(table)
                batch.clear()
        if batch:
            table = pa.Table.from_pylist(batch)
            writer = writer or pq.ParquetWriter(parquet_path, table.schema)
            writer.write_table(table)
        elif writer is None:
            # Empty input still yields a valid empty parquet file with no fields.
            pq.write_table(pa.table({}), parquet_path)
    finally:
        if writer is not None:
            writer.close()
