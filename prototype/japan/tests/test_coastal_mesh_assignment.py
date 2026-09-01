from __future__ import annotations

import unittest

from shapely.geometry import box

from scripts.build_tokyo_kanagawa_test import BoundaryOwnershipIndex, assign_prefecture, mesh_center


class CoastalMeshAssignmentTest(unittest.TestCase):
    def test_mesh_center_uses_the_absolute_jis_longitude_interval(self) -> None:
        longitude, latitude = mesh_center("5339051213")

        self.assertAlmostEqual(longitude, 139.6515625)
        self.assertAlmostEqual(latitude, 35.34479166666667)

    def test_500m_mesh_digit_selects_a_quadrant_instead_of_a_diagonal_offset(self) -> None:
        southwest = mesh_center("533945671")
        southeast = mesh_center("533945672")
        northwest = mesh_center("533945673")
        northeast = mesh_center("533945674")

        self.assertAlmostEqual(southwest[1], southeast[1])
        self.assertAlmostEqual(northwest[1], northeast[1])
        self.assertAlmostEqual(southwest[0], northwest[0])
        self.assertAlmostEqual(southeast[0], northeast[0])
        self.assertAlmostEqual(southeast[0] - southwest[0], 22.5 / 3600)
        self.assertAlmostEqual(northwest[1] - southwest[1], 15 / 3600)

    def test_250m_mesh_digit_subdivides_its_parent_quadrant(self) -> None:
        southwest = mesh_center("5339456711")
        southeast = mesh_center("5339456712")
        northwest = mesh_center("5339456713")
        northeast = mesh_center("5339456714")

        self.assertAlmostEqual(southwest[1], southeast[1])
        self.assertAlmostEqual(northwest[1], northeast[1])
        self.assertAlmostEqual(southwest[0], northwest[0])
        self.assertAlmostEqual(southeast[0], northeast[0])
        self.assertAlmostEqual(southeast[0] - southwest[0], 11.25 / 3600)
        self.assertAlmostEqual(northwest[1] - southwest[1], 7.5 / 3600)

    def test_water_centroid_keeps_full_coastal_cell_mass(self) -> None:
        code = "533916901"
        longitude, latitude = mesh_center(code)
        selected = box(longitude - 0.003125, latitude - 1 / 480, longitude - 0.0001, latitude + 1 / 480)

        assignment = assign_prefecture(code, BoundaryOwnershipIndex({"13": selected}, {"13": selected}))

        self.assertEqual(assignment, ("13", 1.0, "coastal-water-centroid"))

    def test_neighbor_centroid_only_allocates_selected_intersection_fraction(self) -> None:
        code = "533916901"
        longitude, latitude = mesh_center(code)
        selected = box(longitude - 0.003125, latitude - 1 / 480, longitude - 0.0001, latitude + 1 / 480)
        neighbor = box(longitude - 0.0001, latitude - 1 / 480, longitude + 0.003125, latitude + 1 / 480)

        index = BoundaryOwnershipIndex({"13": selected}, {"13": selected, "11": neighbor})
        pref_code, factor, assignment_kind = assign_prefecture(code, index)

        self.assertEqual(pref_code, "13")
        self.assertGreater(factor, 0)
        self.assertLess(factor, 1)
        self.assertEqual(assignment_kind, "neighbor-prefecture-border-fraction")


if __name__ == "__main__":
    unittest.main()
