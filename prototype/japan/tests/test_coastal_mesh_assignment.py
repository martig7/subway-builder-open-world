from __future__ import annotations

import unittest

from shapely.geometry import Point, box

from scripts.build_tokyo_kanagawa_test import (
    BoundaryOwnershipIndex,
    assign_prefecture,
    mesh_center,
    number,
    relocate_into_boundary,
)


class CoastalMeshAssignmentTest(unittest.TestCase):
    def test_published_number_parser_handles_values_and_suppression(self) -> None:
        self.assertEqual(number("1,234"), 1234)
        self.assertEqual(number("*"), 0)
        self.assertEqual(number(None), 0)

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

        self.assertEqual(assignment, ("13", "maximum-render-boundary-overlap"))

    def test_neighbor_centroid_has_one_national_owner_without_fractional_mass(self) -> None:
        code = "533916901"
        longitude, latitude = mesh_center(code)
        selected = box(longitude - 0.003125, latitude - 1 / 480, longitude - 0.0001, latitude + 1 / 480)
        neighbor = box(longitude - 0.0001, latitude - 1 / 480, longitude + 0.003125, latitude + 1 / 480)

        index = BoundaryOwnershipIndex({"13": selected}, {"13": selected, "11": neighbor})
        pref_code, assignment_kind = assign_prefecture(code, index)

        self.assertEqual(pref_code, "11")
        self.assertEqual(assignment_kind, "center-inside-render-boundary")

    def test_outside_centroid_moves_inside_without_changing_ownership(self) -> None:
        boundary = box(139.0, 35.0, 139.1, 35.1)
        index = BoundaryOwnershipIndex({"13": boundary}, {"13": boundary})

        longitude, latitude, relocated, distance_m = relocate_into_boundary(138.999, 35.05, "13", index)

        self.assertTrue(relocated)
        self.assertGreater(distance_m, 0)
        self.assertTrue(boundary.covers(Point(longitude, latitude)))


if __name__ == "__main__":
    unittest.main()
