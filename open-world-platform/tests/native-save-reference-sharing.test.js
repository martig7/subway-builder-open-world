import test from 'node:test';
import assert from 'node:assert/strict';
import { shareNativeSaveReferences } from '../src/runtime/native-save-reference-sharing.js';

test('native save sharing preserves every value without modifying source records', () => {
  const route = () => [{routeId:'r',stationIds:['a','b']},{routeId:'s',stationIds:['b','c']}];
  const save={data:{money:42,tracks:[{id:'track'}],compressedDemandData:{v:2,p:[['pop',1,2]],c:[
    {p:'one',s:2,sr:route(),js:1,je:2,o:'home'}, {p:'two',s:3,sr:route(),js:3,je:4,o:'work'}]},
    completedCommutes:[{popId:'other',stationRoutes:route()}]}};
  const before=structuredClone(save), shared=shareNativeSaveReferences(save);
  assert.deepEqual(shared,before);assert.deepEqual(save,before);
  assert.notEqual(save.data.compressedDemandData.c[0].sr,save.data.compressedDemandData.c[1].sr);
  assert.equal(shared.data.compressedDemandData.c[0].sr,shared.data.compressedDemandData.c[1].sr);
  assert.equal(shared.data.completedCommutes[0].stationRoutes,shared.data.compressedDemandData.c[0].sr);
  assert.deepEqual(JSON.parse(JSON.stringify(shared)),JSON.parse(JSON.stringify(save)));
});

test('different routes, station order and unknown native fields are never merged', () => {
  const paths=[[{routeId:'r',stationIds:['a','b']}],[{routeId:'r',stationIds:['b','a']}],
    [{routeId:'s',stationIds:['a','b']}],[{routeId:'r',stationIds:['a','b'],extra:undefined}]];
  const save={data:{compressedDemandData:{v:2,c:paths.map(sr=>({sr}))}}};
  const result=shareNativeSaveReferences(save);
  assert.deepEqual(result,save);assert.equal(new Set(result.data.compressedDemandData.c.map(c=>c.sr)).size,4);
});

test('saving already shared commute paths does not allocate another copy of every native record', () => {
  const stationRoutes = [{ routeId: 'r', stationIds: ['a', 'b'] }];
  const save = { data: { compressedDemandData: { v: 2, c: Array.from({ length: 1000 }, (_, i) => ({
    p: `pop-${i}`, s: 10, sr: stationRoutes, js: i, je: i + 1, o: 'home',
  })) } } };
  const result = shareNativeSaveReferences(save);
  assert.equal(result, save);
  assert.equal(result.data.compressedDemandData.c[999], save.data.compressedDemandData.c[999]);
  assert.equal(result.data.compressedDemandData.c[0].sr, stationRoutes);
});

test('sharing is copy on write and a second preparation reuses the complete outgoing graph', () => {
  const segment = { routeId: 'r', stationIds: ['a', 'b'] };
  const other = { routeId: 's', stationIds: ['b', 'c'] };
  const first = { sr: [segment], p: 'first' };
  const second = { sr: [{ ...segment, stationIds: [...segment.stationIds] }, other], p: 'second' };
  const third = { sr: [{ ...segment, stationIds: [...segment.stationIds] }], p: 'third' };
  const save = { data: { compressedDemandData: { c: [first, second, third] } } };
  const result = shareNativeSaveReferences(save);
  assert.equal(result.data.compressedDemandData.c[0], first);
  assert.equal(result.data.compressedDemandData.c[1].sr[0], segment);
  assert.equal(result.data.compressedDemandData.c[1].sr[1], other);
  assert.equal(result.data.compressedDemandData.c[2].sr, first.sr);
  assert.equal(shareNativeSaveReferences(result), result);
  assert.deepEqual(result, save);
});
