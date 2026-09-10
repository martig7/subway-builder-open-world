// Sources, calculations, price years, and the complete assumption register:
// docs/research/high-speed-maglev-trains.md and SOURCES.md.
// Native API units: https://www.subwaybuilder.com/docs/api-reference/trains
export const INTERCITY_TRAINS_VERSION = 'open-world-intercity-trains-v1';

export function createIntercityTrainTypes() {
  return [
    {
      id: 'open-world-high-speed',
      name: 'High Speed Rail',
      description: 'ICE 3neo inspired: 320 km/h, 8-car sets, 440 seats per set. Build dedicated high-speed tracks and 210–420 m platforms. Costs are estimates in 2020 USD.',
      stats: {
        // DB: 320 km/h, 201 m, 8 cars, 439 seats. Homogeneous cars round to 440.
        // https://www.bahn.de/service/ueber-uns/zugtypen/ice-3neo
        maxSpeed: 320 / 3.6,
        maxAcceleration: 0.5,
        maxDeceleration: 0.6,
        maxLateralAcceleration: 1,
        maxCantMm: 180,
        maxCantDeficiencyMm: 150,
        maxSlopePercentage: 4,
        maxSpeedLocalStation: 160 / 3.6,
        crossoverSpeed: 40 / 3.6,
        yardSpeedLimit: 4.47,
        stopTimeSeconds: 90,
        turnaroundTimeSeconds: 300,
        minTurnRadius: 300,
        minStationTurnRadius: 2000,
        parallelTrackSpacing: 3.065, // 4.5 m centers minus native 1.435 m rail width.
        trackClearance: 1.5,
        minCars: 8,
        maxCars: 16,
        carsPerCarSet: 8,
        capacityPerCar: 55,
        carLength: 201 / 8,
        trainWidth: 2.95,
        minStationLength: 210,
        maxStationLength: 420,
        // Siemens 2020 order: EUR 1bn / 30 sets / 8 cars * 1.141 USD/EUR.
        // https://assets.new.siemens.com/siemens/assets/api/uuid:cfaa1a08-e7b2-446d-b046-0cc18dc6994f/DB-invests-one-billion-euros-in-new-ICE.pdf
        carCost: 4_750_000,
        // Infrastructure and operating values are game estimates; see report.
        baseTrackCost: 100_000,
        baseStationCost: 100_000_000,
        trainOperationalCostPerHour: 300,
        carOperationalCostPerHour: 125,
        trackMaintenanceCostPerMeter: 50,
        stationMaintenanceCostPerYear: 500_000,
        tphLimit: 12,
      },
      compatibleTrackTypes: ['open-world-high-speed'],
      appearance: { color: '#dc2626' },
      allowGradeCrossing: false,
      allowAtGradeRoadCrossing: false,
      elevationMultipliers: { AT_GRADE: 0.2, TRENCHED: 0.35, RAMP: 0.35, ELEVATED: 0.35, CUT_AND_COVER: 1 },
    },
    {
      id: 'open-world-maglev',
      name: 'Maglev',
      description: 'Transrapid inspired: up to 430 km/h, 100 seats per car, 3–10 cars. Requires dedicated guideway and 80–260 m platforms. Costs are planning estimates in 2020 USD; guideway uses the game’s rail rendering and physics.',
      stats: {
        // Historic commercial maximum, not today's Shanghai timetable or a record.
        // https://www.nra.gov.cn/xwzx/xwxx/xwlb/202204/t20220405_280276.shtml
        maxSpeed: 430 / 3.6,
        // FRA 2005 Transrapid assessment: ~3.3 ft/s², ~82 ft cars, ~100 seats.
        // https://railroads.dot.gov/sites/fra.dot.gov/files/fra_net/1176/maglev-sep05.pdf
        maxAcceleration: 1,
        maxDeceleration: 1,
        maxLateralAcceleration: 1,
        // Effective banking equivalents for native rail physics, not maglev cant specs.
        maxCantMm: 180,
        maxCantDeficiencyMm: 150,
        maxSlopePercentage: 10,
        maxSpeedLocalStation: 160 / 3.6,
        crossoverSpeed: 40 / 3.6,
        yardSpeedLimit: 4.47,
        stopTimeSeconds: 90,
        turnaroundTimeSeconds: 180,
        minTurnRadius: 350,
        minStationTurnRadius: 2000,
        parallelTrackSpacing: 3.765, // 5.2 m centers expressed in the native rail model.
        trackClearance: 1.8,
        minCars: 3,
        maxCars: 10,
        carsPerCarSet: 1,
        capacityPerCar: 100,
        carLength: 25,
        trainWidth: 3.7,
        minStationLength: 80,
        maxStationLength: 260,
        // FRA Baltimore planning proxy: $11.7m (2002) * CPI 258.811 / 179.9.
        carCost: 16_800_000,
        baseTrackCost: 150_000,
        baseStationCost: 150_000_000,
        trainOperationalCostPerHour: 300,
        carOperationalCostPerHour: 500,
        trackMaintenanceCostPerMeter: 75,
        stationMaintenanceCostPerYear: 750_000,
        tphLimit: 12,
      },
      compatibleTrackTypes: ['open-world-maglev'],
      appearance: { color: '#0891b2' },
      allowGradeCrossing: false,
      allowAtGradeRoadCrossing: false,
      elevationMultipliers: { AT_GRADE: 0.3, TRENCHED: 0.4, RAMP: 0.4, ELEVATED: 0.4, CUT_AND_COVER: 1 },
    },
  ];
}

export function registerIntercityTrains(api) {
  if (typeof api?.trains?.registerTrainType !== 'function') {
    return { version: INTERCITY_TRAINS_VERSION, status: 'unavailable', ids: [] };
  }
  // Register on every mod load: the native registry may be reset by hot reload.
  // Fresh objects avoid retaining host mutations or changing owned inventory.
  const definitions = createIntercityTrainTypes();
  for (const definition of definitions) api.trains.registerTrainType(definition);
  return { version: INTERCITY_TRAINS_VERSION, status: 'registered', ids: definitions.map(type => type.id) };
}
