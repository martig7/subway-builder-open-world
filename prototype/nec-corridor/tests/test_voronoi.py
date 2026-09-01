import sqlite3

from nec_world_builder.voronoi import pack_voronoi_cohorts


def test_cross_tile_cohort_snapping_respects_home_and_work_site_roles() -> None:
    database = sqlite3.connect(":memory:")
    database.execute(
        "CREATE TABLE cross_site_flows("
        "home_tile TEXT, work_tile TEXT, home_site TEXT, work_site TEXT, mass INTEGER)"
    )
    database.executemany(
        "INSERT INTO cross_site_flows VALUES ('HOME', 'WORK', ?, 'W', ?)",
        [("H0", 40), ("H1", 60)],
    )
    # Merging the two home cohorts produces x=4. Without role-restricted
    # snapping, the adjacent tile's site X wins even though it cannot be a home
    # for this directed HOME -> WORK flow.
    sites = {
        "H0": {"id": "H0", "tileId": "HOME", "x": 0.0, "y": 0.0},
        "H1": {"id": "H1", "tileId": "HOME", "x": 10.0, "y": 0.0},
        "W": {"id": "W", "tileId": "WORK", "x": 0.0, "y": 10.0},
        "X": {"id": "X", "tileId": "WORK", "x": 4.0, "y": 0.0},
    }

    cohorts = pack_voronoi_cohorts(
        database,
        "HOME->WORK",
        sites,
        50,
        200,
        125,
        flow_query=(
            "SELECT home_site,work_site,mass FROM cross_site_flows "
            "WHERE home_tile=? AND work_tile=?"
        ),
        flow_parameters=("HOME", "WORK"),
        home_site_ids=("H0", "H1"),
        work_site_ids=("W",),
    )

    assert sum(cohort["mass"] for cohort in cohorts) == 100
    assert {cohort["home"] for cohort in cohorts} <= {"H0", "H1"}
    assert {cohort["work"] for cohort in cohorts} == {"W"}
