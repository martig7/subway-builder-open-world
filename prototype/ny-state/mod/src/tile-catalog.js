// Compatibility binding for behavioral tests; runnable entries are generated centrally.
import { createOpenWorldCatalog } from '../../../../open-world-platform/src/runtime/open-world-catalog.js';
import definition from '../../../../worlds/ny-state/world.json' with { type: 'json' };
import catalogSource from '../../../../worlds/ny-state/geography/tile-views.json' with { type: 'json' };

export const { PILOT_TILE_IDS, tileCatalog, tileById } = createOpenWorldCatalog({ definition, catalogSource });
