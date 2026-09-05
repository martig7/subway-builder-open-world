"""Read source records for water-area assembly failures without altering data."""
import argparse
import json
import osmium


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True)
    parser.add_argument("--area-ids", type=int, nargs='+', required=True)
    args = parser.parse_args()
    ways = {i // 2 for i in args.area_ids if i % 2 == 0}
    relations = {i // 2 for i in args.area_ids if i % 2}

    class Inspect(osmium.SimpleHandler):
        def relation(self, relation):
            if relation.id in relations:
                print(json.dumps({"type": "relation", "id": relation.id, "tags": dict(relation.tags),
                                  "members": [{"type": m.type, "ref": m.ref, "role": m.role} for m in relation.members]}), flush=True)

        def way(self, way):
            if way.id in ways:
                print(json.dumps({"type": "way", "id": way.id, "tags": dict(way.tags),
                                  "nodes": [n.ref for n in way.nodes]}), flush=True)

    Inspect().apply_file(args.pbf)
