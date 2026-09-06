import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertWorldDefinition } from './validate-world-definition.js';
import { sha256Value } from './canonical-hash.js';

export async function loadWorldDefinition(worldRoot) {
  const resolvedWorldRoot = path.resolve(worldRoot);
  const definitionPath = path.join(resolvedWorldRoot, 'world.json');
  const definition = assertWorldDefinition(JSON.parse(await readFile(definitionPath, 'utf8')));
  const resolveContained = (relativePath) => {
    const resolved = path.resolve(resolvedWorldRoot, relativePath);
    if (resolved !== resolvedWorldRoot && !resolved.startsWith(`${resolvedWorldRoot}${path.sep}`)) {
      throw new Error(`World path escapes its directory: ${relativePath}`);
    }
    return resolved;
  };
  const catalogPath = resolveContained(definition.tileViews.catalog);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const ids = new Set();
  for (const tile of catalog.tiles ?? []) {
    if (typeof tile.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tile.id) || ids.has(tile.id)) throw new Error(`Invalid or duplicate Tile View ID: ${tile.id}`);
    ids.add(tile.id);
  }
  const selectedTiles = (catalog.tiles ?? []).filter((tile) => tile.status === 'selected');
  if (!selectedTiles.some((tile) => tile.id === definition.tileViews.initialTileId)) {
    throw new Error(`Initial Tile View is not selected: ${definition.tileViews.initialTileId}`);
  }
  if (definition.map.worldContextTileId != null
    && !selectedTiles.some((tile) => tile.id === definition.map.worldContextTileId)) {
    throw new Error(`World context Tile Package is not selected: ${definition.map.worldContextTileId}`);
  }
  return {
    worldRoot: resolvedWorldRoot,
    definitionPath,
    definition,
    worldDefinitionHash: sha256Value(definition),
    catalogPath,
    catalog,
    selectedTiles,
    resolveContained,
  };
}
