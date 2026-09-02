import path from 'node:path';

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANIFEST_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const GLOBAL_NAME = /^[A-Z][A-Z0-9_]+$/;
const SUPPORTED_DEMAND_ADAPTERS = new Set(['lodes-us', 'estat-japan']);

function requireObject(value, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value;
}

function requireString(value, label, errors, pattern = null) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${label} must be a non-empty string`);
  else if (pattern && !pattern.test(value)) errors.push(`${label} has an invalid value: ${value}`);
}

function requireRelativeJsonPath(value, label, errors) {
  requireString(value, label, errors);
  if (typeof value !== 'string') return;
  const normalized = value.replaceAll('\\\\', '/');
  if (path.isAbsolute(value) || normalized.split('/').includes('..') || !/\.(?:geo)?json$/.test(normalized)) {
    errors.push(`${label} must be a contained relative JSON path`);
  }
}

export function validateWorldDefinition(definition) {
  const errors = [];
  const root = requireObject(definition, 'World Definition', errors);
  if (root.schemaVersion !== 1) errors.push('schemaVersion must equal 1');

  const identity = requireObject(root.identity, 'identity', errors);
  requireString(identity.worldId, 'identity.worldId', errors, STABLE_ID);
  requireString(identity.artifactWorldId, 'identity.artifactWorldId', errors, STABLE_ID);
  requireString(identity.manifestId, 'identity.manifestId', errors, MANIFEST_ID);
  for (const key of ['name', 'description', 'version', 'author']) requireString(identity[key], `identity.${key}`, errors);
  if (!Array.isArray(identity.compatibilityLineage) || identity.compatibilityLineage.length === 0) {
    errors.push('identity.compatibilityLineage must contain at least one stable identity');
  }

  const tileViews = requireObject(root.tileViews, 'tileViews', errors);
  requireRelativeJsonPath(tileViews.catalog, 'tileViews.catalog', errors);
  requireString(tileViews.initialTileId, 'tileViews.initialTileId', errors, STABLE_ID);
  if (tileViews.boundaryOverlay != null) requireRelativeJsonPath(tileViews.boundaryOverlay, 'tileViews.boundaryOverlay', errors);

  const map = requireObject(root.map, 'map', errors);
  requireRelativeJsonPath(map.sourceLock, 'map.sourceLock', errors);
  requireString(map.profile, 'map.profile', errors, STABLE_ID);
  requireString(map.basemapRevision, 'map.basemapRevision', errors, STABLE_ID);

  const demand = requireObject(root.demand, 'demand', errors);
  if (!SUPPORTED_DEMAND_ADAPTERS.has(demand.adapter)) errors.push(`demand.adapter is unsupported: ${demand.adapter ?? '(missing)'}`);
  requireRelativeJsonPath(demand.definition, 'demand.definition', errors);
  requireString(demand.routingProfile, 'demand.routingProfile', errors, STABLE_ID);
  if (!Array.isArray(demand.nativePopPrefixes) || demand.nativePopPrefixes.length === 0) errors.push('demand.nativePopPrefixes must be a non-empty array');
  if (!Array.isArray(demand.crossPopPrefixes) || demand.crossPopPrefixes.length === 0) errors.push('demand.crossPopPrefixes must be a non-empty array');

  const runtime = requireObject(root.runtime, 'runtime', errors);
  requireString(runtime.storageNamespace, 'runtime.storageNamespace', errors, STABLE_ID);
  if (!Number.isInteger(runtime.tileServerPort) || runtime.tileServerPort < 1024 || runtime.tileServerPort > 65535) {
    errors.push('runtime.tileServerPort must be an unprivileged TCP port');
  }
  requireString(runtime.tileBaseGlobal, 'runtime.tileBaseGlobal', errors, GLOBAL_NAME);
  requireString(runtime.diagnosticNamespace, 'runtime.diagnosticNamespace', errors, STABLE_ID);
  requireString(runtime.healthTile, 'runtime.healthTile', errors);
  if (!Array.isArray(runtime.requiredHostCapabilities)) errors.push('runtime.requiredHostCapabilities must be an array');

  const release = requireObject(root.release, 'release', errors);
  requireString(release.platformCompatibility, 'release.platformCompatibility', errors);
  if (release.artifactSelection !== 'explicit') errors.push('release.artifactSelection must be explicit');
  if (!['split-map-demand-v1', 'packaged-tile-directories-v1'].includes(release.artifactLayout)) {
    errors.push(`release.artifactLayout is unsupported: ${release.artifactLayout ?? '(missing)'}`);
  }

  return { valid: errors.length === 0, errors };
}

export function assertWorldDefinition(definition) {
  const result = validateWorldDefinition(definition);
  if (!result.valid) throw new Error(`Invalid World Definition:\n- ${result.errors.join('\n- ')}`);
  return definition;
}
