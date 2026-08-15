import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
  chooseModes,
  createNetworkProfile,
  inspectCrossTileModeChoice,
} from "../src/cross-tile-mode-choice.js";
import { decodeMetroSave } from "./inspect-metro-save.mjs";

const SAVE_DIRECTORY = "D:\\SubwayBuilder";
const MOD_STATE_PATH =
  "C:\\Users\\darkd\\AppData\\Roaming\\metro-maker4\\mod-data\\local.kc-two-tile-open-world-prototype.json";
const CROSS_DEMAND_PATH = path.resolve("../artifacts/KCW/cross_demand.json.gz");

function latestMetroSave(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".metro"))
    .map((name) => ({
      filePath: path.join(directory, name),
      modified: fs.statSync(path.join(directory, name)).mtimeMs,
    }))
    .sort((a, b) => b.modified - a.modified)[0]?.filePath;
}

function unpackNativeDemand(compressed) {
  const pops = new Map(compressed.p);
  const points = new Map(compressed.d);
  return { pops, points };
}

function pathBreakdown(path) {
  if (!path) return null;
  return {
    totalTime: path.totalTime,
    perceivedTime: path.perceivedTime,
    fareCost: path.fareCost,
    ...path.timeBreakdown,
  };
}

function scoreSimilarity(nativePop, nativePath, comparison) {
  const timeRatio = comparison.driving.clockSeconds / nativePop.ds;
  const distanceRatio = comparison.driving.distanceMetres / nativePop.dd;
  const leg = comparison.transitPath.continuousLeg;
  const crossWalk = (leg?.accessWalkSeconds ?? 0) + (leg?.egressWalkSeconds ?? 0);
  const nativeWalk = nativePath.timeBreakdown.walk;
  const walkRatio = Math.max(1, crossWalk) / Math.max(1, nativeWalk);
  return (
    Math.abs(Math.log(timeRatio))
    + Math.abs(Math.log(distanceRatio))
    + Math.abs(Math.log(walkRatio))
  );
}

function inferNativeDrivingMultiplier(nativePop, transitPath) {
  const candidates = [0.8, 0.9, 1, 1.25, 1.5];
  const actual = nativePop.lc.mc;
  return candidates
    .map((multiplier) => {
      const calculated = chooseModes({
        population: nativePop.s,
        drivingTime: nativePop.ds,
        drivingDistance: nativePop.dd,
        transitTime: transitPath.perceivedTime,
        walkTime: nativePop.lc.w.time,
        transitCost: transitPath.fareCost,
        pathfindingRules: { DRIVING_TIMES: { HIGH_DEMAND: multiplier } },
      });
      const error = ["driving", "transit", "walking"].reduce(
        (sum, mode) => sum + Math.abs((calculated[mode] ?? 0) - (actual[mode] ?? 0)),
        0,
      );
      return { multiplier, calculated, error };
    })
    .sort((left, right) => left.error - right.error)[0];
}

function compactCross(comparison) {
  const leg = comparison.transitPath.continuousLeg;
  return {
    popId: comparison.popId,
    population: comparison.population,
    homeTileId: comparison.homeTileId,
    workTileId: comparison.workTileId,
    gatewayId: comparison.gatewayId,
    modes: comparison.modes,
    driving: comparison.driving,
    transit: comparison.transit,
    walking: comparison.walking,
    representativePerson: comparison.representativePerson,
    transitPath: {
      available: comparison.transitPath.available,
      continuous: comparison.transitPath.continuous,
      totalClockSeconds: comparison.transitPath.totalClockSeconds,
      totalPerceivedSeconds: comparison.transitPath.totalSeconds,
      accessWalkSeconds: leg?.accessWalkSeconds,
      egressWalkSeconds: leg?.egressWalkSeconds,
      transferWalkSeconds: leg?.transferWalkSeconds,
      waitSeconds: leg?.waitSeconds,
      departureShiftSeconds: leg?.departureShiftSeconds,
      inVehicleSeconds: leg?.networkSeconds,
      stationPath: leg?.stationPath,
    },
  };
}

const savePath = process.argv[2] ?? latestMetroSave(SAVE_DIRECTORY);
if (!savePath) throw new Error("No .metro save found");
const save = decodeMetroSave(savePath).mainSave;
const nativeDemand = unpackNativeDemand(save.data.compressedDemandData);
const nativeCandidates = [...nativeDemand.pops.values()].filter(
  (pop) => pop.lc?.tp?.length && (pop.lc.mc?.transit ?? 0) > 0,
);
if (!nativeCandidates.length) throw new Error("Latest save has no native pop with a retained transit path");
const nativePop = nativeCandidates.sort(
  (left, right) => (right.lc.mc.transit / right.s) - (left.lc.mc.transit / left.s),
)[0];
const nativePath = nativePop.lc.tp[0];
const inferredMultiplier = inferNativeDrivingMultiplier(nativePop, nativePath);

const modState = JSON.parse(fs.readFileSync(MOD_STATE_PATH, "utf8"));
const world = modState[`world:${save.gameSessionId}`];
if (!world) throw new Error(`No mod world matches save session ${save.gameSessionId}`);
const profile = createNetworkProfile({
  tileId: save.cityCode,
  stations: save.data.stations,
  routes: save.data.routes,
  trains: save.data.trains,
});
const networkProfiles = {
  ...Object.fromEntries(
    Object.entries(world.tiles ?? {})
      .filter(([, tile]) => tile.networkProfile)
      .map(([tileId, tile]) => [tileId, tile.networkProfile]),
  ),
  [save.cityCode]: profile,
};
const crossDemand = JSON.parse(zlib.gunzipSync(fs.readFileSync(CROSS_DEMAND_PATH)));
const requestedDepartureSeconds =
  nativePath.segments[0].departureTime - nativePath.timeBreakdown.departureShift;

const viable = crossDemand.pops
  .map((_, popIndex) => ({
    popIndex,
    comparison: inspectCrossTileModeChoice({
      crossDemand,
      popIndex,
      networkProfiles,
      gatewayCatalog: world.gatewayCatalog,
      fare: save.data.transitCost,
      requestedDepartureSeconds,
    }),
  }))
  .filter(({ comparison }) => comparison.transitPath.available)
  .map((candidate) => ({
    ...candidate,
    similarity: scoreSimilarity(nativePop, nativePath, candidate.comparison),
  }))
  .sort((left, right) => left.similarity - right.similarity);

if (!viable.length) throw new Error("No cross-city pop has a transit path in the current network");
const matched = viable[0];
const matchedComparison = matched.comparison;
const matchedFlowKey = `${matchedComparison.homeTileId}|${matchedComparison.workTileId}|${matchedComparison.gatewayId}`;
const matchedLedgerEntry = Object.values(world.gatewayLedger).find((entry) => {
  const flow = entry.flow;
  return `${flow.homeTileId}|${flow.workTileId}|${flow.gatewayId}` === matchedFlowKey;
});
const matchedModesAtNativeMultiplier = chooseModes({
  population: matchedComparison.population,
  drivingTime: matchedComparison.driving.clockSeconds,
  drivingDistance: matchedComparison.driving.distanceMetres,
  transitTime: matchedComparison.transit.perceivedSeconds,
  walkTime: matchedComparison.walking.clockSeconds,
  transitCost: matchedComparison.transit.moneyCost,
  pathfindingRules: {
    DRIVING_TIMES: { HIGH_DEMAND: inferredMultiplier.multiplier },
  },
});
const result = {
  inputs: {
    savePath,
    saveId: save.id,
    gameSessionId: save.gameSessionId,
    cityCode: save.cityCode,
    elapsedSeconds: save.data.elapsedSeconds,
    requestedDepartureSeconds,
    currentFare: save.data.transitCost,
    crossDemandBuild: crossDemand.drivingModel,
    networkSignature: profile.signature,
    viableCrossPops: viable.length,
  },
  native: {
    popId: nativePop.i,
    population: nativePop.s,
    homePointId: nativePop.ri,
    workPointId: nativePop.ji,
    drivingSeconds: nativePop.ds,
    drivingDistance: nativePop.dd,
    walkingSeconds: nativePop.lc.w.time,
    modes: nativePop.lc.mc,
    path: pathBreakdown(nativePath),
    inferredDrivingTimeMultiplier: inferredMultiplier,
  },
  cross: {
    popIndex: matched.popIndex,
    similarityScore: matched.similarity,
    ...compactCross(matchedComparison),
    modesAtNativeDrivingMultiplier: matchedModesAtNativeMultiplier,
    displayedGatewayBucket: matchedLedgerEntry
      ? {
          flowId: matchedLedgerEntry.flow.id,
          population: matchedLedgerEntry.flow.mass,
          modes: matchedLedgerEntry.modeChoice,
          transitPercent:
            100 * matchedLedgerEntry.modeChoice.transit / matchedLedgerEntry.flow.mass,
        }
      : null,
  },
  nearestAlternatives: viable.slice(0, 5).map(({ popIndex, similarity, comparison }) => ({
    popIndex,
    similarity,
    popId: comparison.popId,
    drivingSeconds: comparison.driving.clockSeconds,
    drivingDistance: comparison.driving.distanceMetres,
    transitPerceivedSeconds: comparison.transit.perceivedSeconds,
    transitClockSeconds: comparison.transit.clockSeconds,
    modes: comparison.modes,
  })),
};

console.log(JSON.stringify(result, null, 2));
