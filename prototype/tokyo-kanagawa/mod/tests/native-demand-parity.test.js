import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { cityDefinitionsFor } from '../src/city-registration.js';

test('native city codes match open-world tile and data-directory IDs', () => {
  for (const city of cityDefinitionsFor()) {
    assert.equal(city.code, city.tileId, `${city.code} must address tile ${city.tileId}`);
  }
});

test('both native demand packages match the game schema and contain in-tile demand', async () => {
  for (const city of cityDefinitionsFor()) {
    const packageUrl = new URL(`../../generated/mod/tiles/${city.tileId}/demand_data.json.gz`, import.meta.url);
    const demand = JSON.parse(gunzipSync(await readFile(packageUrl)));
    assert.ok(Array.isArray(demand.points) && demand.points.length > 0, `${city.code} points`);
    assert.ok(Array.isArray(demand.pops) && demand.pops.length > 0, `${city.code} pops`);

    const pointIds = new Set(demand.points.map((point) => point.id));
    assert.ok(demand.points.some((point) => Number(point.residents) > 0), `${city.code} residents`);
    assert.ok(demand.points.some((point) => Number(point.jobs) > 0), `${city.code} jobs`);
    for (const population of demand.pops) {
      assert.ok(Number(population.size) > 0, `${city.code} population size`);
      assert.ok(pointIds.has(population.residenceId), `${city.code} residence ${population.residenceId}`);
      assert.ok(pointIds.has(population.jobId), `${city.code} job ${population.jobId}`);
    }
  }
});
