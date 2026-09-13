"""Extract demand frontage support from existing local OSM files only."""
import argparse
import json
from pathlib import Path
from open_world_map_creator.demand.road_support import RoadSupportCache

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map-config', type=Path, required=True)
    parser.add_argument('--osm-root', type=Path, required=True)
    parser.add_argument('--cache-root', type=Path, required=True)
    args = parser.parse_args()
    RoadSupportCache(json.loads(args.map_config.read_text()), args.osm_root, args.cache_root,
                     lambda message: print(message, flush=True)).prepare()
