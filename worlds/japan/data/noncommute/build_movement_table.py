#!/usr/bin/env python3
"""Build Japan's weekday non-commute movement ledger and compact map data."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence


NATIONAL_FILE = "2015DW_207OD_DK.xls"
TOKYO_FILE = "tokyo-2018-purpose-mode.csv"
TOKYO_CODE_FILE = "tokyo-2018-zone-code.xlsx"
CHUKYO_FILE = "chukyo-2022-purpose-mode.xlsx"
CHUKYO_CODE_FILE = "chukyo-2022-zone-code.xlsx"
KINKI_FILE = "kinki-2021-purpose-mode.xlsx"
ZONE_CORRESPONDENCE_FILE = "207-zone-correspondence.pdf"

SOURCE_URLS = {
    NATIONAL_FILE: "https://www.mlit.go.jp/common/001297377.xls",
    TOKYO_FILE: "https://www.e-stat.go.jp/stat-search/file-download?statInfId=000032066127&fileKind=1",
    TOKYO_CODE_FILE: "https://www.tokyo-pt.jp/static/hp/file/data/H30_zonecode.xlsx",
    CHUKYO_FILE: "https://www.e-stat.go.jp/stat-search/file-download?statInfId=000040268715&fileKind=0",
    CHUKYO_CODE_FILE: "https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/offer/pdf/20260622_code.xlsx",
    KINKI_FILE: "https://www.e-stat.go.jp/stat-search/file-download?statInfId=000040170629&fileKind=0",
    ZONE_CORRESPONDENCE_FILE: "https://www.mlit.go.jp/seisakutokatsu/jyunryuudou/doc/207_Zone2005.pdf",
}

SOURCE_LABELS = {
    "national": "2015 National Survey of Net Passenger Flow",
    "tokyo": "2018 Tokyo Person Trip survey",
    "chukyo": "2022 Chukyo Person Trip survey",
    "kinki": "2021 Kinki Person Trip survey",
}

SOURCE_YEARS = {"national": 2015, "tokyo": 2018, "chukyo": 2022, "kinki": 2021}

METRO_GROUPS = {
    "tokyo": frozenset({"11", "12", "13", "14"}),
    "chukyo": frozenset({"21", "23", "24"}),
    "kinki": frozenset({"26", "27", "28", "29"}),
}

COVERAGE = {
    "national": "national trunk survey scope; metropolitan group and same-prefecture movements excluded",
    "tokyo": "partial: surveyed residents; Tokyo island municipalities excluded",
    "chukyo": "partial: surveyed residents; only surveyed portions of Gifu and Mie",
    "kinki": "surveyed residents across the four target prefectures",
}

PURPOSE_BUSINESS_PRIVATE = "B"
PURPOSE_COMMUTE_SCHOOL = "C"
PURPOSE_RETURN_HOME = "R"
PURPOSE_UNKNOWN = "U"
PURPOSE_TOTAL = "T"

CSV_FIELDS = [
    "origin_zone",
    "origin_zone_name",
    "origin_prefecture_code",
    "destination_zone",
    "destination_zone_name",
    "destination_prefecture_code",
    "estimated_movements_per_weekday",
    "rounded_movements_per_weekday",
    "source",
    "year",
    "coverage",
    "zone_level",
    "value_status",
    "business_private_movements",
    "return_home_movements",
    "return_allocation_fraction",
    "unknown_purpose_omitted",
]


@dataclass(frozen=True)
class NationalZone:
    code: str
    name: str
    prefecture_code: str
    prefecture_group_code: int


@dataclass
class CoordinateAccumulator:
    weighted_longitude: float = 0.0
    weighted_latitude: float = 0.0
    weight: float = 0.0
    area_longitude: float = 0.0
    area_latitude: float = 0.0
    area_weight: float = 0.0

    def add(self, longitude: float, latitude: float, population: float, area: float) -> None:
        if population > 0:
            self.weighted_longitude += longitude * population
            self.weighted_latitude += latitude * population
            self.weight += population
        if area > 0:
            self.area_longitude += longitude * area
            self.area_latitude += latitude * area
            self.area_weight += area

    def coordinate(self) -> tuple[float, float, str]:
        if self.weight > 0:
            return (
                self.weighted_longitude / self.weight,
                self.weighted_latitude / self.weight,
                "population-weighted",
            )
        if self.area_weight > 0:
            return (
                self.area_longitude / self.area_weight,
                self.area_latitude / self.area_weight,
                "area-weighted",
            )
        raise ValueError("coordinate accumulator has no usable weight")


def clean_code(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def number(value: object) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "")
    return int(Decimal(text)) if text else 0


def rounded(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def decimal_text(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.000001")), "f")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prefecture_code(prefecture_group_code: int) -> str:
    if prefecture_group_code in {1, 48, 49, 50}:
        return "01"
    if 2 <= prefecture_group_code <= 47:
        return f"{prefecture_group_code:02d}"
    raise ValueError(f"unexpected 50-prefecture group code {prefecture_group_code}")


def same_metro_group(origin_prefecture: str, destination_prefecture: str) -> bool:
    return any(
        origin_prefecture in members and destination_prefecture in members
        for members in METRO_GROUPS.values()
    )


def extract_national_matrix(path: Path) -> tuple[list[NationalZone], list[list[object]]]:
    try:
        import xlrd
    except ImportError as exc:  # pragma: no cover - environment guidance
        raise RuntimeError("Install the map-creator 'japan' extras to read legacy .xls files") from exc

    book = xlrd.open_workbook(path, on_demand=True)
    try:
        sheet = book.sheet_by_name("代_全機関_全目的")
        codes = [clean_code(sheet.cell_value(7, column)) for column in range(3, 3 + 207)]
        names = [clean_code(sheet.cell_value(9, column)) for column in range(3, 3 + 207)]
        origin_codes = [clean_code(sheet.cell_value(row, 0)) for row in range(10, 10 + 207)]
        origin_names = [clean_code(sheet.cell_value(row, 2)) for row in range(10, 10 + 207)]
        if codes != origin_codes or names != origin_names:
            raise ValueError("national workbook origin and destination zone axes do not match")
        matrix = [
            [sheet.cell_value(row, column) for column in range(3, 3 + 207)]
            for row in range(10, 10 + 207)
        ]
    finally:
        book.release_resources()

    zones = [NationalZone(code=code, name=name, prefecture_code="", prefecture_group_code=0) for code, name in zip(codes, names)]
    return zones, matrix


def parse_correspondence_record(text: str, valid_zone_codes: set[str]) -> tuple[int, str, str, str] | None:
    compact = re.sub(r"\s+", " ", text).strip()
    match = re.match(
        r"^(\d{1,2})\s*([^\d]+?)\s+(\d{2,3})\s*(.+?)\s+(\d{4,5})\s*(.*)$",
        compact,
    )
    if not match:
        return None
    group_code = int(match.group(1))
    zone_code = match.group(3)
    if zone_code not in valid_zone_codes or not 1 <= group_code <= 50:
        return None
    municipality_code = match.group(5).zfill(5)
    municipality_label = match.group(6).strip()
    return group_code, zone_code, municipality_code, municipality_label


def extract_zone_correspondence(
    path: Path, valid_zone_codes: set[str]
) -> tuple[dict[str, int], dict[str, list[tuple[str, str]]]]:
    from pypdf import PdfReader

    groups: dict[str, int] = {}
    municipalities: dict[str, list[tuple[str, str]]] = defaultdict(list)
    reader = PdfReader(path)
    for page in reader.pages[1:13]:
        rows: dict[float, dict[str, list[tuple[float, str]]]] = defaultdict(
            lambda: {"left": [], "right": []}
        )

        def visit(text: str, _cm: Sequence[float], tm: Sequence[float], _font: object, _size: float) -> None:
            stripped = text.strip()
            if not stripped:
                return
            x, y = float(tm[4]), float(tm[5])
            side = "left" if x < 240 else "right"
            rows[round(y, 1)][side].append((x, stripped))

        page.extract_text(visitor_text=visit)
        for sides in rows.values():
            for tokens in sides.values():
                joined = " ".join(text for _, text in sorted(tokens))
                parsed = parse_correspondence_record(joined, valid_zone_codes)
                if parsed is None:
                    continue
                group_code, zone_code, municipality_code, municipality_label = parsed
                previous = groups.setdefault(zone_code, group_code)
                if previous != group_code:
                    raise ValueError(f"zone {zone_code} appears in multiple prefecture groups")
                municipalities[zone_code].append((municipality_code, municipality_label))

    missing = valid_zone_codes - groups.keys()
    if missing:
        raise ValueError(f"zone correspondence is missing {len(missing)} zone(s): {sorted(missing)}")
    return groups, dict(municipalities)


def attach_prefectures(zones: Sequence[NationalZone], group_codes: Mapping[str, int]) -> list[NationalZone]:
    return [
        NationalZone(
            code=zone.code,
            name=zone.name,
            prefecture_code=prefecture_code(group_codes[zone.code]),
            prefecture_group_code=group_codes[zone.code],
        )
        for zone in zones
    ]


def build_national_rows(
    zones: Sequence[NationalZone], matrix: Sequence[Sequence[object]]
) -> tuple[list[dict[str, object]], dict[str, int]]:
    rows: list[dict[str, object]] = []
    counts = defaultdict(int)
    for origin_index, origin in enumerate(zones):
        for destination_index, destination in enumerate(zones):
            raw = matrix[origin_index][destination_index]
            if origin.prefecture_code == destination.prefecture_code:
                counts["same_prefecture_excluded"] += 1
                continue
            if same_metro_group(origin.prefecture_code, destination.prefecture_code):
                if clean_code(raw) not in {"", "－", "-"}:
                    raise ValueError(
                        f"national metropolitan cell {origin.code}->{destination.code} unexpectedly contains {raw!r}"
                    )
                counts["metropolitan_excluded"] += 1
                continue
            if clean_code(raw) in {"－", "-"}:
                raise ValueError(f"unexpected excluded national cell {origin.code}->{destination.code}")
            if clean_code(raw) == "":
                amount: int | str = ""
                status = "unreported_blank"
            else:
                amount = number(raw)
                status = "reported_zero" if amount == 0 else "published_estimate"
            counts[status] += 1
            rows.append(
                {
                    "origin_zone": f"mlit207:{origin.code}",
                    "origin_zone_name": origin.name,
                    "origin_prefecture_code": origin.prefecture_code,
                    "destination_zone": f"mlit207:{destination.code}",
                    "destination_zone_name": destination.name,
                    "destination_prefecture_code": destination.prefecture_code,
                    "estimated_movements_per_weekday": amount,
                    "rounded_movements_per_weekday": amount,
                    "source": SOURCE_LABELS["national"],
                    "year": SOURCE_YEARS["national"],
                    "coverage": COVERAGE["national"],
                    "zone_level": "207-life-area",
                    "value_status": status,
                    "business_private_movements": "",
                    "return_home_movements": "",
                    "return_allocation_fraction": "",
                    "unknown_purpose_omitted": "",
                }
            )
    return rows, dict(counts)


def normalize_tokyo_zone(value: object) -> str:
    match = re.match(r"^:(\d{4})(?:\s|$)", clean_code(value))
    return match.group(1) if match else ""


def load_tokyo_zone_prefectures(path: Path) -> dict[str, str]:
    import openpyxl

    name_to_code = {"埼玉県": "11", "千葉県": "12", "東京都": "13", "神奈川県": "14"}
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    mapping: dict[str, str] = {}
    try:
        sheet = book["市区町村別ゾーン一覧"]
        for row in sheet.iter_rows(min_row=2, values_only=True):
            pref_name, zone_code = clean_code(row[0]), clean_code(row[4]).zfill(4)
            pref_code = name_to_code.get(pref_name)
            if pref_code is None or not zone_code.isdigit():
                continue
            previous = mapping.setdefault(zone_code, pref_code)
            if previous != pref_code:
                raise ValueError(f"Tokyo PT zone {zone_code} crosses prefectures")
    finally:
        book.close()
    return mapping


def load_chukyo_zone_prefectures(path: Path) -> dict[str, str]:
    import openpyxl

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    mapping: dict[str, str] = {}
    try:
        sheet = book["2"]
        for row in sheet.iter_rows(min_row=7, values_only=True):
            zone_code = clean_code(row[0]).zfill(5)
            if not zone_code.isdigit() or len(zone_code) != 5:
                continue
            middle_zone = int(zone_code[:3])
            if 1 <= middle_zone < 200:
                mapping[zone_code] = "23"
            elif 200 <= middle_zone < 300:
                mapping[zone_code] = "21"
            elif 300 <= middle_zone < 400:
                mapping[zone_code] = "24"
    finally:
        book.close()
    return mapping


def classify_purpose(region: str, purpose: str) -> str:
    mappings = {
        "tokyo": {
            "自宅－勤務": PURPOSE_COMMUTE_SCHOOL,
            "自宅－通学": PURPOSE_COMMUTE_SCHOOL,
            "自宅－業務": PURPOSE_BUSINESS_PRIVATE,
            "自宅－私事": PURPOSE_BUSINESS_PRIVATE,
            "勤務・業務": PURPOSE_BUSINESS_PRIVATE,
            "私事": PURPOSE_BUSINESS_PRIVATE,
            "帰宅": PURPOSE_RETURN_HOME,
            "不明": PURPOSE_UNKNOWN,
            "計": PURPOSE_TOTAL,
        },
        "chukyo": {
            "出勤": PURPOSE_COMMUTE_SCHOOL,
            "登校": PURPOSE_COMMUTE_SCHOOL,
            "自由": PURPOSE_BUSINESS_PRIVATE,
            "業務": PURPOSE_BUSINESS_PRIVATE,
            "帰宅": PURPOSE_RETURN_HOME,
            "不明": PURPOSE_UNKNOWN,
            "計": PURPOSE_TOTAL,
        },
        "kinki": {
            "出勤": PURPOSE_COMMUTE_SCHOOL,
            "登校": PURPOSE_COMMUTE_SCHOOL,
            "自由": PURPOSE_BUSINESS_PRIVATE,
            "業務": PURPOSE_BUSINESS_PRIVATE,
            "帰宅": PURPOSE_RETURN_HOME,
            "不明": PURPOSE_UNKNOWN,
            "合計": PURPOSE_TOTAL,
        },
    }
    if purpose not in mappings[region]:
        raise ValueError(f"unmapped {region} purpose {purpose!r}")
    return mappings[region][purpose]


RegionalRecord = tuple[str, str, str, int]


def iter_tokyo_records(data_path: Path, code_path: Path) -> Iterator[RegionalRecord]:
    zone_prefectures = load_tokyo_zone_prefectures(code_path)
    with data_path.open("r", encoding="cp932", newline="") as handle:
        reader = csv.reader(handle)
        for _ in range(5):
            next(reader)
        for row in reader:
            if len(row) < 12:
                continue
            origin_zone = normalize_tokyo_zone(row[0])
            destination_zone = normalize_tokyo_zone(row[1])
            origin_prefecture = zone_prefectures.get(origin_zone)
            destination_prefecture = zone_prefectures.get(destination_zone)
            if origin_prefecture and destination_prefecture:
                yield origin_prefecture, destination_prefecture, clean_code(row[2]), number(row[11])


def iter_chukyo_records(data_path: Path, code_path: Path) -> Iterator[RegionalRecord]:
    import openpyxl

    zone_prefectures = load_chukyo_zone_prefectures(code_path)
    book = openpyxl.load_workbook(data_path, read_only=True, data_only=True)
    try:
        sheet = book.active
        for row in sheet.iter_rows(min_row=6, values_only=True):
            if clean_code(row[3]) != "計":
                continue
            origin_prefecture = zone_prefectures.get(clean_code(row[0]).zfill(5))
            destination_prefecture = zone_prefectures.get(clean_code(row[1]).zfill(5))
            if origin_prefecture and destination_prefecture:
                yield origin_prefecture, destination_prefecture, clean_code(row[2]), number(row[10])
    finally:
        book.close()


def kinki_prefecture(value: object) -> str | None:
    name = clean_code(value)
    if "京都" in name:
        return "26"
    if "大阪" in name or "堺" in name:
        return "27"
    if "兵庫" in name or "神戸" in name:
        return "28"
    if "奈良" in name:
        return "29"
    return None


def iter_kinki_records(data_path: Path) -> Iterator[RegionalRecord]:
    import openpyxl

    book = openpyxl.load_workbook(data_path, read_only=True, data_only=True)
    try:
        sheet = book.active
        for row in sheet.iter_rows(min_row=6, values_only=True):
            if clean_code(row[0]) in {"", "00000", "合計"} or clean_code(row[6]) in {
                "",
                "00000",
                "合計",
            }:
                continue
            origin_prefecture = kinki_prefecture(row[5])
            destination_prefecture = kinki_prefecture(row[11])
            if origin_prefecture and destination_prefecture:
                yield origin_prefecture, destination_prefecture, clean_code(row[12]), number(row[21])
    finally:
        book.close()


def aggregate_region(
    region: str,
    records: Iterable[RegionalRecord],
    prefecture_names: Mapping[str, str],
) -> tuple[list[dict[str, object]], dict[str, object]]:
    members = METRO_GROUPS[region]
    pair_totals: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: {
            PURPOSE_BUSINESS_PRIVATE: 0,
            PURPOSE_COMMUTE_SCHOOL: 0,
            PURPOSE_RETURN_HOME: 0,
            PURPOSE_UNKNOWN: 0,
            PURPOSE_TOTAL: 0,
        }
    )
    for origin, destination, purpose, amount in records:
        if origin == destination or origin not in members or destination not in members:
            continue
        category = classify_purpose(region, purpose)
        pair_totals[(origin, destination)][category] += amount

    expected_pairs = {(origin, destination) for origin in members for destination in members if origin != destination}
    missing = expected_pairs - pair_totals.keys()
    if missing:
        raise ValueError(f"{region} is missing {len(missing)} target prefecture pair(s): {sorted(missing)}")
    mismatched_totals = {
        pair: totals
        for pair, totals in pair_totals.items()
        if sum(totals[category] for category in (
            PURPOSE_BUSINESS_PRIVATE,
            PURPOSE_COMMUTE_SCHOOL,
            PURPOSE_RETURN_HOME,
            PURPOSE_UNKNOWN,
        ))
        != totals[PURPOSE_TOTAL]
    }
    if mismatched_totals:
        raise ValueError(
            f"{region} purpose components do not reconcile for "
            f"{len(mismatched_totals)} target prefecture pair(s)"
        )

    business_private = sum(values[PURPOSE_BUSINESS_PRIVATE] for values in pair_totals.values())
    commute_school = sum(values[PURPOSE_COMMUTE_SCHOOL] for values in pair_totals.values())
    denominator = business_private + commute_school
    if denominator == 0:
        raise ValueError(f"{region} return-allocation denominator is zero")
    q = Decimal(business_private) / Decimal(denominator)

    rows: list[dict[str, object]] = []
    for origin, destination in sorted(expected_pairs):
        totals = pair_totals[(origin, destination)]
        estimate = Decimal(totals[PURPOSE_BUSINESS_PRIVATE]) + q * Decimal(totals[PURPOSE_RETURN_HOME])
        rows.append(
            {
                "origin_zone": f"prefecture:{origin}",
                "origin_zone_name": prefecture_names[origin],
                "origin_prefecture_code": origin,
                "destination_zone": f"prefecture:{destination}",
                "destination_zone_name": prefecture_names[destination],
                "destination_prefecture_code": destination,
                "estimated_movements_per_weekday": decimal_text(estimate),
                "rounded_movements_per_weekday": rounded(estimate),
                "source": SOURCE_LABELS[region],
                "year": SOURCE_YEARS[region],
                "coverage": COVERAGE[region],
                "zone_level": "prefecture",
                "value_status": "modeled_return_allocation",
                "business_private_movements": totals[PURPOSE_BUSINESS_PRIVATE],
                "return_home_movements": totals[PURPOSE_RETURN_HOME],
                "return_allocation_fraction": decimal_text(q),
                "unknown_purpose_omitted": totals[PURPOSE_UNKNOWN],
            }
        )

    report = {
        "pairCount": len(rows),
        "businessPrivateMovements": business_private,
        "commuteSchoolMovements": commute_school,
        "returnHomeMovements": sum(values[PURPOSE_RETURN_HOME] for values in pair_totals.values()),
        "unknownPurposeOmitted": sum(values[PURPOSE_UNKNOWN] for values in pair_totals.values()),
        "reportedAllPurposesMovements": sum(
            values[PURPOSE_TOTAL] for values in pair_totals.values()
        ),
        "classifiedPurposeMovements": sum(
            sum(values[category] for category in (
                PURPOSE_BUSINESS_PRIVATE,
                PURPOSE_COMMUTE_SCHOOL,
                PURPOSE_RETURN_HOME,
                PURPOSE_UNKNOWN,
            ))
            for values in pair_totals.values()
        ),
        "returnAllocationFraction": decimal_text(q),
        "estimatedMovementsPerWeekday": decimal_text(
            sum(Decimal(row["estimated_movements_per_weekday"]) for row in rows)
        ),
        "roundedMovementsPerWeekday": sum(int(row["rounded_movements_per_weekday"]) for row in rows),
    }
    return rows, report


def read_boundary_municipalities(
    boundary_dir: Path,
) -> tuple[dict[str, dict[str, object]], dict[str, CoordinateAccumulator]]:
    try:
        import shapefile
    except ImportError as exc:  # pragma: no cover - environment guidance
        raise RuntimeError("Install the map-creator 'japan' extras to read boundary archives") from exc

    municipality_accumulators: dict[str, CoordinateAccumulator] = defaultdict(CoordinateAccumulator)
    municipality_names: dict[str, str] = {}
    prefecture_accumulators: dict[str, CoordinateAccumulator] = defaultdict(CoordinateAccumulator)
    for pref_number in range(1, 48):
        pref_code = f"{pref_number:02d}"
        archive = boundary_dir / f"pref-{pref_code}.zip"
        if not archive.exists():
            raise FileNotFoundError(f"missing e-Stat boundary archive {archive}")
        with zipfile.ZipFile(archive) as source:
            dbf_name = next(name for name in source.namelist() if name.lower().endswith(".dbf"))
            dbf_bytes = BytesIO(source.read(dbf_name))
        reader = shapefile.Reader(dbf=dbf_bytes, encoding="cp932", encodingErrors="replace")
        fields = [field[0] for field in reader.fields[1:]]
        for record in reader.iterRecords():
            values = dict(zip(fields, record))
            city = clean_code(values.get("CITY")).zfill(3)
            city_name = clean_code(values.get("CITY_NAME"))
            if not city.isdigit() or not city_name:
                continue
            municipality_code = f"{pref_code}{city}"
            longitude = float(values.get("X_CODE") or 0)
            latitude = float(values.get("Y_CODE") or 0)
            if not 120 <= longitude <= 155 or not 20 <= latitude <= 50:
                continue
            population = float(values.get("JINKO") or 0)
            area = float(values.get("AREA") or 0)
            municipality_names[municipality_code] = city_name
            municipality_accumulators[municipality_code].add(longitude, latitude, population, area)
            prefecture_accumulators[pref_code].add(longitude, latitude, population, area)

    municipalities: dict[str, dict[str, object]] = {}
    for code, accumulator in municipality_accumulators.items():
        longitude, latitude, method = accumulator.coordinate()
        municipalities[code] = {
            "name": municipality_names[code],
            "longitude": longitude,
            "latitude": latitude,
            "populationWeight": accumulator.weight,
            "areaWeight": accumulator.area_weight,
            "method": method,
        }
    return municipalities, prefecture_accumulators


def normalized_admin_name(value: str) -> str:
    return re.sub(r"\s+", "", value).replace("ヶ", "ケ")


def zone_coordinates(
    zones: Sequence[NationalZone],
    correspondence: Mapping[str, Sequence[tuple[str, str]]],
    municipalities: Mapping[str, Mapping[str, object]],
    prefecture_accumulators: Mapping[str, CoordinateAccumulator],
) -> tuple[list[dict[str, object]], dict[str, int]]:
    names_by_prefecture: dict[str, dict[str, str]] = defaultdict(dict)
    for code, municipality in municipalities.items():
        names_by_prefecture[code[:2]][normalized_admin_name(str(municipality["name"]))] = code

    results: list[dict[str, object]] = []
    method_counts: dict[str, int] = defaultdict(int)
    for zone in zones:
        matched_codes: set[str] = set()
        for municipality_code, municipality_label in correspondence[zone.code]:
            if municipality_code in municipalities:
                matched_codes.add(municipality_code)
                continue
            normalized_label = normalized_admin_name(municipality_label)
            for current_name, current_code in names_by_prefecture[zone.prefecture_code].items():
                if current_name and normalized_label.endswith(current_name):
                    matched_codes.add(current_code)

        method = "crosswalk-population-weighted"
        accumulator = CoordinateAccumulator()
        for code in matched_codes:
            municipality = municipalities[code]
            weight = float(municipality["populationWeight"])
            area = float(municipality["areaWeight"])
            accumulator.add(
                float(municipality["longitude"]),
                float(municipality["latitude"]),
                weight,
                area,
            )
        if not matched_codes:
            method = "prefecture-population-fallback"
            accumulator = prefecture_accumulators[zone.prefecture_code]
        longitude, latitude, weighting = accumulator.coordinate()
        method_counts[method] += 1
        results.append(
            {
                "zone": f"mlit207:{zone.code}",
                "zone_name": zone.name,
                "prefecture_code": zone.prefecture_code,
                "longitude": round(longitude, 6),
                "latitude": round(latitude, 6),
                "centroid_method": method,
                "weighting": weighting,
                "matched_current_municipalities": len(matched_codes),
            }
        )
    return results, dict(method_counts)


def prefecture_nodes(
    region_prefectures: set[str],
    prefecture_names: Mapping[str, str],
    prefecture_accumulators: Mapping[str, CoordinateAccumulator],
) -> list[dict[str, object]]:
    nodes = []
    for pref_code in sorted(region_prefectures):
        longitude, latitude, weighting = prefecture_accumulators[pref_code].coordinate()
        nodes.append(
            {
                "zone": f"prefecture:{pref_code}",
                "zone_name": prefecture_names[pref_code],
                "prefecture_code": pref_code,
                "longitude": round(longitude, 6),
                "latitude": round(latitude, 6),
                "centroid_method": "prefecture-population-weighted",
                "weighting": weighting,
                "matched_current_municipalities": "",
            }
        )
    return nodes


def write_csv(path: Path, rows: Sequence[Mapping[str, object]], fields: Sequence[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def compact_map_data(
    zone_rows: Sequence[Mapping[str, object]], movement_rows: Sequence[Mapping[str, object]]
) -> dict[str, object]:
    nodes = [
        [
            row["zone"],
            row["zone_name"],
            row["prefecture_code"],
            row["longitude"],
            row["latitude"],
            row["centroid_method"],
        ]
        for row in zone_rows
    ]
    node_index = {str(row[0]): index for index, row in enumerate(nodes)}
    source_ids = {SOURCE_LABELS[key]: index for index, key in enumerate(("national", "tokyo", "chukyo", "kinki"))}
    flows = []
    for row in movement_rows:
        amount = number(row["rounded_movements_per_weekday"])
        if amount <= 0:
            continue
        origin = node_index[str(row["origin_zone"])]
        destination = node_index[str(row["destination_zone"])]
        flows.append([origin, destination, amount, source_ids[str(row["source"])]])
    return {
        "schemaVersion": 1,
        "nodeFields": ["id", "name", "prefectureCode", "longitude", "latitude", "centroidMethod"],
        "flowFields": ["originNodeIndex", "destinationNodeIndex", "movementsPerWeekday", "sourceIndex"],
        "sources": [SOURCE_LABELS[key] for key in ("national", "tokyo", "chukyo", "kinki")],
        "nodes": nodes,
        "flows": flows,
    }


def default_root() -> Path:
    return Path(__file__).resolve().parents[4]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    root = default_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=root / "map-creator/data/sources/japan/noncommute/raw",
        help="Directory containing the seven downloaded official source files",
    )
    parser.add_argument(
        "--boundary-dir",
        type=Path,
        default=root / "prototype/japan/raw-data/estat/boundaries",
        help="Directory containing the existing pref-01.zip through pref-47.zip e-Stat boundaries",
    )
    parser.add_argument(
        "--prefecture-names",
        type=Path,
        default=root / "worlds/japan/geography/prefecture-display-names.json",
    )
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    raw_dir = args.raw_dir.resolve()
    boundary_dir = args.boundary_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    required_files = list(SOURCE_URLS)
    for filename in required_files:
        if not (raw_dir / filename).exists():
            raise FileNotFoundError(f"missing source file {raw_dir / filename}")
    prefecture_names = json.loads(args.prefecture_names.read_text(encoding="utf-8"))

    provisional_zones, matrix = extract_national_matrix(raw_dir / NATIONAL_FILE)
    group_codes, correspondence = extract_zone_correspondence(
        raw_dir / ZONE_CORRESPONDENCE_FILE, {zone.code for zone in provisional_zones}
    )
    zones = attach_prefectures(provisional_zones, group_codes)
    national_rows, national_report = build_national_rows(zones, matrix)
    national_report["estimatedMovementsPerWeekday"] = sum(
        number(row["rounded_movements_per_weekday"]) for row in national_rows
    )

    regional_rows: list[dict[str, object]] = []
    regional_report: dict[str, object] = {}
    region_inputs = {
        "tokyo": iter_tokyo_records(raw_dir / TOKYO_FILE, raw_dir / TOKYO_CODE_FILE),
        "chukyo": iter_chukyo_records(raw_dir / CHUKYO_FILE, raw_dir / CHUKYO_CODE_FILE),
        "kinki": iter_kinki_records(raw_dir / KINKI_FILE),
    }
    for region, records in region_inputs.items():
        rows, report = aggregate_region(region, records, prefecture_names)
        regional_rows.extend(rows)
        regional_report[region] = report

    movement_rows = national_rows + regional_rows
    movement_rows.sort(key=lambda row: (str(row["origin_zone"]), str(row["destination_zone"])))

    municipalities, prefecture_accumulators = read_boundary_municipalities(boundary_dir)
    national_zone_rows, centroid_report = zone_coordinates(
        zones, correspondence, municipalities, prefecture_accumulators
    )
    regional_prefectures = set().union(*METRO_GROUPS.values())
    zone_rows = national_zone_rows + prefecture_nodes(
        regional_prefectures, prefecture_names, prefecture_accumulators
    )
    zone_rows.sort(key=lambda row: str(row["zone"]))

    write_csv(output_dir / "movements.csv", movement_rows, CSV_FIELDS)
    write_csv(
        output_dir / "zones.csv",
        zone_rows,
        [
            "zone",
            "zone_name",
            "prefecture_code",
            "longitude",
            "latitude",
            "centroid_method",
            "weighting",
            "matched_current_municipalities",
        ],
    )

    source_lock = {
        "schemaVersion": 1,
        "sources": [
            {
                "filename": filename,
                "url": SOURCE_URLS[filename],
                "bytes": (raw_dir / filename).stat().st_size,
                "sha256": sha256(raw_dir / filename),
            }
            for filename in required_files
        ],
    }
    (output_dir / "sources.lock.json").write_text(
        json.dumps(source_lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    map_data = compact_map_data(zone_rows, movement_rows)
    (output_dir / "map-data.json").write_text(
        json.dumps(map_data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )

    report = {
        "schemaVersion": 1,
        "unit": "one-way movements per representative weekday",
        "zoneCount": len(zones),
        "mapNodeCount": len(zone_rows),
        "movementRowCount": len(movement_rows),
        "positiveMovementRowCount": sum(
            number(row["rounded_movements_per_weekday"]) > 0 for row in movement_rows
        ),
        "estimatedMovementsPerWeekday": decimal_text(
            sum(
                Decimal(str(row["estimated_movements_per_weekday"]))
                for row in movement_rows
                if row["estimated_movements_per_weekday"] != ""
            )
        ),
        "roundedMovementsPerWeekday": sum(
            number(row["rounded_movements_per_weekday"]) for row in movement_rows
        ),
        "national": national_report,
        "regional": regional_report,
        "zoneCentroids": centroid_report,
        "checks": {
            "nationalZoneCountIs207": len(zones) == 207,
            "nationalCellsPartitioned": sum(
                national_report[key]
                for key in (
                    "same_prefecture_excluded",
                    "metropolitan_excluded",
                    "published_estimate",
                    "reported_zero",
                    "unreported_blank",
                )
            ) == len(zones) ** 2,
            "regionalPairCountIs30": len(regional_rows) == 30,
            "allMovementRowsHaveOneSource": all(bool(row["source"]) for row in movement_rows),
            "movementPairKeysAreUnique": len(movement_rows)
            == len({(row["origin_zone"], row["destination_zone"]) for row in movement_rows}),
            "regionalPurposeTotalsReconcile": all(
                details["reportedAllPurposesMovements"]
                == details["classifiedPurposeMovements"]
                for details in regional_report.values()
            ),
            "allMapEndpointsResolve": all(
                row[0] < len(map_data["nodes"]) and row[1] < len(map_data["nodes"])
                for row in map_data["flows"]
            ),
            "allZoneCoordinatesFinite": all(
                math.isfinite(float(row["longitude"])) and math.isfinite(float(row["latitude"]))
                for row in zone_rows
            ),
        },
    }
    if not all(report["checks"].values()):
        raise ValueError(f"build checks failed: {report['checks']}")
    (output_dir / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
