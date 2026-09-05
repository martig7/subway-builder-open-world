"""Classify each commute exactly once, using its final building owners."""


class OwnedDemandLedger:
    def __init__(self, codes, estimate):
        self.estimate = estimate
        self.native = {code: {'points': [], 'pops': []} for code in codes}
        self.points = {code: {} for code in codes}
        self.cross = []
        self.reports = {code: {'sourceLocalMass': 0, 'nativeMass': 0, 'divertedMass': 0,
            'pointCount': 0, 'cohortCount': 0, 'divertedCohortCount': 0} for code in codes}

    def add(self, record):
        home, work = record.home, record.work
        if home.owner_pref not in self.native or work.owner_pref not in self.native:
            raise ValueError('Demand endpoint has no final owner')
        if home.force_cross or work.force_cross:
            raise ValueError('Boundary-first ledger cannot accept unresolved placement flags')
        source_local = record.source_origin_pref == record.source_destination_pref
        if source_local:
            self.reports[record.source_origin_pref]['sourceLocalMass'] += record.mass
        if home.owner_pref != work.owner_pref:
            self.cross.append(record)
            if source_local:
                report = self.reports[record.source_origin_pref]
                report['divertedMass'] += record.mass
                report['divertedCohortCount'] += 1
            return
        owner = home.owner_pref
        seconds, distance = self.estimate(home, work)
        self.native[owner]['pops'].append({'id': record.id, 'size': record.mass,
            'residenceId': home.id, 'jobId': work.id, 'drivingSeconds': seconds, 'drivingDistance': distance})
        for site, field in [(home, 'residents'), (work, 'jobs')]:
            point = self.points[owner].setdefault(site.id, {'id': site.id,
                'location': [site.longitude, site.latitude], 'jobs': 0, 'residents': 0, 'popIds': []})
            if point['location'] != [site.longitude, site.latitude]:
                raise ValueError(f'One site ID has conflicting coordinates: {site.id}')
            point[field] += record.mass
            if not point['popIds'] or point['popIds'][-1] != record.id:
                point['popIds'].append(record.id)
        self.reports[owner]['nativeMass'] += record.mass
        self.reports[owner]['cohortCount'] += 1

    def finish(self):
        for code, payload in self.native.items():
            payload['points'] = [self.points[code][key] for key in sorted(self.points[code])]
            self.reports[code]['pointCount'] = len(payload['points'])
        return self.native, self.reports, self.cross
