import assert from 'node:assert/strict';
import { buildPublicSchedule } from '../public-schedule.js';

const root = { name: '대회', maintenance: { enabled: false }, secret: 'must-not-leak' };
const courts = [
  {
    id: 'court-b',
    data: { name: '  B코트  ', order: 2, recorderName: '기록관 B', uid: 'private-b' },
  },
  {
    id: 'court-a',
    data: { name: 'A', order: 1, recorderName: '기록관 A', lock: { uid: 'private-a' } },
  },
];
const assignments = [
  {
    id: 'final:women:f2',
    data: {
      matchKey: 'forged-match-key',
      matchType: 'final',
      courtId: 'court-a',
      courtOrder: 2,
      publicStatus: 'in_progress',
      score: { sets: [{ a: 10, b: 0 }] },
      recorderName: 'private',
    },
  },
  {
    id: 'prelim-men-1',
    data: {
      matchKey: 'another-forged-key',
      matchType: 'prelim',
      courtId: 'court-a',
      courtOrder: 1,
      lock: { uid: 'private' },
      draft: { sets: [{ a: 1, b: 1 }] },
    },
  },
  {
    id: 'unassigned',
    data: {
      matchType: 'prelim',
      courtId: null,
      courtOrder: 99,
      queue: { next: 'private' },
    },
  },
  {
    id: 'bad-kind',
    data: {
      matchType: 'practice',
      courtId: 'court-a',
      courtOrder: 3,
    },
  },
];

{
  const beforeCourts = structuredClone(courts);
  const beforeAssignments = structuredClone(assignments);
  const payload = buildPublicSchedule({ root, courts, assignments });
  assert.deepEqual(payload, {
    status: 'ready',
    courts: [
      { id: 'court-a', name: 'A' },
      { id: 'court-b', name: 'B' },
    ],
    assignments: [
      { matchKey: 'prelim-men-1', matchType: 'prelim', courtId: 'court-a', courtOrder: 1 },
      { matchKey: 'final:women:f2', matchType: 'final', courtId: 'court-a', courtOrder: 2 },
      { matchKey: 'unassigned', matchType: 'prelim', courtId: null, courtOrder: null },
    ],
  });
  assert.deepEqual(courts, beforeCourts, 'court-input-is-not-mutated');
  assert.deepEqual(assignments, beforeAssignments, 'assignment-input-is-not-mutated');
  assert.equal(JSON.stringify(payload).includes('private'), false, 'private-fields-are-not-projected');
  assert.deepEqual(
    Object.keys(payload.assignments[0]),
    ['matchKey', 'matchType', 'courtId', 'courtOrder'],
    'assignment-allowlist-is-exact',
  );
}

{
  const payload = buildPublicSchedule({
    root,
    courts: [{ id: 'known', data: { name: 'K', order: 1 } }],
    assignments: [
      { id: 'unknown-court', data: { matchType: 'prelim', courtId: 'missing', courtOrder: 4 } },
      { id: 'bad-order', data: { matchType: 'final', courtId: 'known', courtOrder: '1' } },
      { id: 'negative-order', data: { matchType: 'prelim', courtId: 'known', courtOrder: -1 } },
      { id: 'fractional-order', data: { matchType: 'prelim', courtId: 'known', courtOrder: 1.5 } },
    ],
  });
  assert.deepEqual(payload.assignments, [
    { matchKey: 'bad-order', matchType: 'final', courtId: null, courtOrder: null },
    { matchKey: 'fractional-order', matchType: 'prelim', courtId: null, courtOrder: null },
    { matchKey: 'negative-order', matchType: 'prelim', courtId: null, courtOrder: null },
    { matchKey: 'unknown-court', matchType: 'prelim', courtId: null, courtOrder: null },
  ], 'malformed-orders-and-courts-are-null-safe');
}

{
  const maintenance = buildPublicSchedule({
    root: { maintenance: { enabled: true } },
    courts,
    assignments,
  });
  const missing = buildPublicSchedule({ root: null, courts, assignments });
  assert.deepEqual(maintenance, { status: 'maintenance', courts: [], assignments: [] });
  assert.deepEqual(missing, { status: 'unavailable', courts: [], assignments: [] });
}

{
  const source = {
    root,
    courts: [
      { id: 'c2', data: { name: '2코트', order: 2 } },
      { id: 'c1', data: { name: '1코트', order: 1 } },
    ],
    assignments: [
      { id: 'final:men:f2', data: { matchType: 'final', courtId: 'c1', courtOrder: 2 } },
      { id: 'prelim:men:p3', data: { matchType: 'prelim', courtId: 'c1', courtOrder: 3 } },
      { id: 'prelim:men:p1', data: { matchType: 'prelim', courtId: 'c1', courtOrder: 1 } },
      { id: 'final:men:f1', data: { matchType: 'final', courtId: 'c1', courtOrder: 4 } },
      { id: 'prelim:men:p2', data: { matchType: 'prelim', courtId: 'c2', courtOrder: 1 } },
    ],
  };
  const shuffled = {
    ...source,
    courts: source.courts.slice().reverse(),
    assignments: source.assignments.slice().reverse(),
  };
  assert.deepEqual(
    buildPublicSchedule(source),
    buildPublicSchedule(shuffled),
    'projection-order-is-deterministic',
  );
  assert.deepEqual(
    buildPublicSchedule(source).assignments.map(({ matchKey }) => matchKey),
    ['prelim:men:p1', 'final:men:f2', 'prelim:men:p3', 'final:men:f1', 'prelim:men:p2'],
    'final-slots-remain-interleaved-by-court-order',
  );
}

console.log('public-schedule fixtures passed');
