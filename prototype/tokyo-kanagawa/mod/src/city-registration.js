// Compatibility binding for behavioral tests; remove when tests import the platform seam directly.
import { createOpenWorldCityRegistration } from '../../../../open-world-platform/src/runtime/open-world-city-registration.js';
import definition from '../../../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import { tileCatalog } from './tile-catalog.js';

export const DEFAULT_TILE_BASE = `http://127.0.0.1:${definition.runtime.tileServerPort}`;
export const BASEMAP_REVISION = definition.map.basemapRevision;
export const {
  cityDefinitionsFor,
  tileUrl: pilotTileUrl,
  refreshPilotCityBindings,
  registerPilotCities,
  repairPilotMapCamera,
  repairPilotMapTileSource,
} = createOpenWorldCityRegistration({ definition, tileCatalog });
