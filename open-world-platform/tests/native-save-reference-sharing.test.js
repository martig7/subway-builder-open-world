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
