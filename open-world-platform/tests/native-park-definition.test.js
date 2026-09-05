import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateWorldDefinition } from '../src/contracts/validate-world-definition.js';

test('NEC and Japan opt into landuse parks and invalid source mappings are rejected', async () => {
  for (const world of ['nec-corridor', 'japan']) {
    const definition = JSON.parse(await readFile(new URL(`../../worlds/${world}/world.json`, import.meta.url)));
    assert.equal(definition.map.nativeParkSourceLayer, 'landuse');
    assert.equal(validateWorldDefinition(definition).valid, true);
    definition.map.nativeParkSourceLayer = 'water';
    assert.equal(validateWorldDefinition(definition).valid, false);
  }
});
