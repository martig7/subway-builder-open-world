from __future__ import annotations

import math
import sqlite3
import unittest

from ny_world_builder.voronoi import cluster_demand_sites, pack_voronoi_cohorts


class DemandSiteVoronoiTests(unittest.TestCase):
    def test_partition_is_rotation_equivariant_and_mass_weighted(self) -> None:
        source = [
            (f"block-{x}-{y}", float(x), float(y), 1 + ((x + 2 * y) % 7))
            for x in range(0, 1_001, 25)
            for y in range(0, 1_001, 25)
        ]
        assignment, sites = cluster_demand_sites("TEST", source, 100.0)
        rotated = [(block_id, -y, x, weight) for block_id, x, y, weight in source]
        rotated_assignment, rotated_sites = cluster_demand_sites("TEST", rotated, 100.0)

        cells = {frozenset(block for block, site in assignment.items() if site == site_id) for site_id in sites}
        rotated_cells = {
            frozenset(block for block, site in rotated_assignment.items() if site == site_id)
            for site_id in rotated_sites
        }
        self.assertEqual(cells, rotated_cells)
        self.assertEqual(len(assignment), len(source))

        coordinates = {block_id: (x, y, weight) for block_id, x, y, weight in source}
        for site_id, site in sites.items():
            members = [block for block, assigned in assignment.items() if assigned == site_id]
            total = sum(coordinates[block][2] for block in members)
            expected_x = sum(coordinates[block][0] * coordinates[block][2] for block in members) / total
            expected_y = sum(coordinates[block][1] * coordinates[block][2] for block in members) / total
            self.assertAlmostEqual(site["x"], expected_x)
            self.assertAlmostEqual(site["y"], expected_y)


class CohortVoronoiTests(unittest.TestCase):
    def test_capacity_coarsening_conserves_mass_and_obeys_bounds(self) -> None:
        database = sqlite3.connect(":memory:")
        database.execute(
            "CREATE TABLE site_flows(tile TEXT,home_site TEXT,work_site TEXT,mass INTEGER,"
            "PRIMARY KEY(tile,home_site,work_site))"
        )
        sites = {}
        total_mass = 0
        for x in range(20):
            for y in range(20):
                site_id = f"site-{x:02x}{y:02x}"
                sites[site_id] = {"id": site_id, "x": x * 25.0, "y": y * 25.0}
                work_id = f"site-{(19 - x):02x}{(y * 7) % 20:02x}"
                mass = 1 + ((x * 11 + y * 3) % 4)
                database.execute("INSERT INTO site_flows VALUES(?,?,?,?)", ("TEST", site_id, work_id, mass))
                total_mass += mass
        database.commit()

        cohorts = pack_voronoi_cohorts(database, "TEST", sites, 50, 200, 125, chunk_size=37)
        self.assertEqual(sum(row["mass"] for row in cohorts), total_mass)
        self.assertTrue(all(50 <= row["mass"] <= 200 for row in cohorts))
        self.assertGreater(len({row["home"] for row in cohorts}), 1)
        self.assertGreater(len({row["work"] for row in cohorts}), 1)

    def test_large_existing_pair_splits_into_balanced_cohorts(self) -> None:
        database = sqlite3.connect(":memory:")
        database.execute(
            "CREATE TABLE site_flows(tile TEXT,home_site TEXT,work_site TEXT,mass INTEGER,"
            "PRIMARY KEY(tile,home_site,work_site))"
        )
        sites = {
            "home-a": {"id": "home-a", "x": 0.0, "y": 0.0},
            "work-a": {"id": "work-a", "x": 1_000.0, "y": 0.0},
        }
        database.execute("INSERT INTO site_flows VALUES('TEST','home-a','work-a',401)")
        cohorts = pack_voronoi_cohorts(database, "TEST", sites, 50, 200, 125)
        self.assertEqual([134, 134, 133], sorted((row["mass"] for row in cohorts), reverse=True))

    def test_custom_flow_partition_uses_only_the_requested_tile_pair(self) -> None:
        database = sqlite3.connect(":memory:")
        database.execute("CREATE TABLE cross_flows(home_tile TEXT,work_tile TEXT,home_site TEXT,work_site TEXT,mass INTEGER)")
        sites = {
            "a": {"id": "a", "x": 0.0, "y": 0.0},
            "b": {"id": "b", "x": 100.0, "y": 0.0},
            "c": {"id": "c", "x": 200.0, "y": 0.0},
        }
        database.executemany("INSERT INTO cross_flows VALUES(?,?,?,?,?)", [
            ("HOME", "WORK", "a", "b", 30),
            ("HOME", "WORK", "b", "c", 30),
            ("OTHER", "WORK", "c", "a", 140),
        ])
        cohorts = pack_voronoi_cohorts(
            database, "HOME->WORK", sites, 50, 200, 125,
            flow_query="SELECT home_site,work_site,mass FROM cross_flows WHERE home_tile=? AND work_tile=?",
            flow_parameters=("HOME", "WORK"),
        )
        self.assertEqual(sum(row["mass"] for row in cohorts), 60)
        self.assertTrue(all(50 <= row["mass"] <= 200 for row in cohorts))


if __name__ == "__main__":
    unittest.main()
