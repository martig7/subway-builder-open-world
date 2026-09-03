from __future__ import annotations

import unittest

import numpy as np
from scipy.sparse import csr_matrix

from open_world_map_creator.routing.generated_roads import RoadGraph


class _IdentityTransformer:
    def transform(self, longitude, latitude):
        return longitude, latitude


def _road_graph(
    coordinates: list[tuple[float, float]],
    edges: list[tuple[int, int, float, float]],
    major_nodes: list[bool],
) -> RoadGraph:
    rows: list[int] = []
    columns: list[int] = []
    seconds: list[float] = []
    metres: list[float] = []
    for left, right, edge_seconds, edge_metres in edges:
        rows.extend((left, right))
        columns.extend((right, left))
        seconds.extend((edge_seconds, edge_seconds))
        metres.extend((edge_metres, edge_metres))
    shape = (len(coordinates), len(coordinates))
    time_graph = csr_matrix((seconds, (rows, columns)), shape=shape)
    metre_graph = csr_matrix((metres, (rows, columns)), shape=shape)
    return RoadGraph(
        coordinates=np.asarray(coordinates, dtype=np.float64),
        indptr=time_graph.indptr,
        indices=time_graph.indices,
        seconds=time_graph.data,
        metres=metre_graph.data,
        components=np.zeros(len(coordinates), dtype=np.int32),
        transformer=_IdentityTransformer(),
        major_nodes=np.asarray(major_nodes, dtype=np.bool_),
    )


class HierarchicalRoutingTests(unittest.TestCase):
    def test_major_road_portal_hierarchy_matches_full_graph(self) -> None:
        graph = _road_graph(
            coordinates=[
                (0.0, 0.0),
                (1.0, 0.0),
                (2.0, 0.0),
                (3.0, 0.0),
                (4.0, 0.0),
                (5.0, 0.0),
            ],
            edges=[
                (0, 1, 1.0, 10.0),
                (1, 2, 1.0, 10.0),
                (2, 3, 1.0, 10.0),
                (0, 3, 10.0, 30.0),
                (3, 4, 1.0, 10.0),
                (4, 5, 1.0, 10.0),
            ],
            major_nodes=[True, False, False, True, False, False],
        )

        report = graph.prepare_major_road_hierarchy(
            maximum_partition_nodes=16,
            maximum_partition_portals=8,
        )

        self.assertEqual(report["contractedPartitionCount"], 2)
        self.assertEqual(graph._astar(0, 3), graph._hierarchical_astar(0, 3))
        self.assertEqual(graph._astar(1, 5), graph._hierarchical_astar(1, 5))
        self.assertEqual(graph._astar(1, 2), graph._hierarchical_astar(1, 2))

    def test_large_minor_partition_stays_in_exact_overlay(self) -> None:
        graph = _road_graph(
            coordinates=[(float(index), 0.0) for index in range(6)],
            edges=[
                (0, 1, 1.0, 10.0),
                (1, 2, 1.0, 10.0),
                (2, 3, 1.0, 10.0),
                (3, 4, 1.0, 10.0),
                (4, 5, 1.0, 10.0),
            ],
            major_nodes=[True, False, False, False, False, True],
        )

        report = graph.prepare_major_road_hierarchy(
            maximum_partition_nodes=2,
            maximum_partition_portals=8,
        )

        self.assertEqual(report["promotedPartitionCount"], 1)
        self.assertEqual(graph._astar(0, 5), graph._hierarchical_astar(0, 5))


if __name__ == "__main__":
    unittest.main()
