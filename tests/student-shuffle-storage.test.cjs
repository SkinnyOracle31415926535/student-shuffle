const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const source = readFileSync(
  new URL('../student-shuffle-storage.js', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.reads = [];
    this.onGet = null;
  }

  getItem(key) {
    this.reads.push(key);
    if (this.onGet) this.onGet(key, this);
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

class LockManager {
  constructor() {
    this.chains = new Map();
    this.calls = [];
  }

  request(name, _options, task) {
    this.calls.push(name);
    const previous = this.chains.get(name) || Promise.resolve();
    const current = previous.then(task);
    this.chains.set(name, current.catch(() => {}));
    return current;
  }
}

function loadStorage(initial = {}) {
  const localStorage = new FakeStorage(initial);
  const locks = new LockManager();
  const events = [];
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    localStorage,
    navigator: { locks },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    TextEncoder,
    CustomEvent,
    console,
  });
  new vm.Script(source, { filename: 'student-shuffle-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__fixtureJson = JSON.stringify(value);
    try {
      return vm.runInContext('JSON.parse(__fixtureJson)', context);
    } finally {
      delete context.__fixtureJson;
    }
  };
  return {
    api: window.StudentShuffleStorage,
    localStorage,
    locks,
    events,
    context,
    realm,
  };
}

const owned = {
  roster: 'student-random-order-roster-v1',
  classes: 'student-random-order-classes-v1',
  selected: 'student-random-order-selected-class-v1',
  hidden: 'student-random-order-hidden-students-v1',
  localExtras: 'student-random-order-local-extras-v1',
  localHidden: 'student-random-order-local-hidden-students-v1',
  sound: 'student-random-order-sound-v1',
};

const attendance = (overrides = {}) => ({
  version: 1,
  selectedClassKey: 'builtin:boys-nga',
  hiddenStudentKeys: ['kenneth chan'],
  ...overrides,
});

const remoteMetadata = (deleted = false) =>
  Object.freeze({ source: 'remote', deleted, revision: 1 });

test('central adapters read only selected class, hidden attendance, and sound', async () => {
  const environment = loadStorage({
    [owned.roster]: 'ROSTER_RESPONSE_ONLY',
    [owned.classes]: '{"cache":"SHARED_CACHE_ONLY"}',
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '["Kenneth Chan"]',
    [owned.localExtras]: '{"version":1,"classes":{"builtin:boys-nga":[{"id":"local:one","displayName":"Local Student"}]}}',
    [owned.localHidden]: '{"version":1,"classes":{"builtin:boys-nga":["local:one"]}}',
    [owned.sound]: 'off',
    unrelated: 'do-not-read',
  });
  const adapters = environment.api.makeAdapters();
  environment.localStorage.reads.length = 0;

  const currentAttendance = await adapters.attendance.readLocal();
  const sound = await adapters.sound.readLocal();

  assert.deepEqual({
    selectedClassKey: currentAttendance.selectedClassKey,
    hiddenStudentKeys: Array.from(currentAttendance.hiddenStudentKeys),
    sound: sound.enabled,
  }, {
    selectedClassKey: 'builtin:boys-nga',
    hiddenStudentKeys: ['kenneth chan'],
    sound: false,
  });
  assert.deepEqual(
    [...new Set(environment.localStorage.reads)].sort(),
    [owned.hidden, owned.selected, owned.sound].sort(),
  );
  assert.ok(environment.locks.calls.every((name) => name === environment.api.aggregateLock));
});

test('exact raw backup contains every owned key and no unrelated storage', () => {
  const environment = loadStorage({
    [owned.roster]: 'ROSTER_RESPONSE_ONLY',
    [owned.classes]: '{"cache":"SHARED_CACHE_ONLY"}',
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '["kenneth chan"]',
    [owned.localExtras]: 'LOCAL_EXTRAS_ONLY',
    [owned.localHidden]: 'LOCAL_HIDDEN_ONLY',
    [owned.sound]: 'off',
    unrelated: 'must-not-leave',
  });
  const backup = environment.api.rawBackup();

  assert.deepEqual(
    Array.from(backup.records, (record) => record.key),
    [
      owned.roster,
      owned.classes,
      owned.selected,
      owned.hidden,
      owned.localExtras,
      owned.localHidden,
      owned.sound,
    ],
  );
  assert.match(JSON.stringify(backup), /ROSTER_RESPONSE_ONLY|SHARED_CACHE_ONLY|LOCAL_EXTRAS_ONLY|LOCAL_HIDDEN_ONLY/);
  assert.doesNotMatch(JSON.stringify(backup), /must-not-leave|unrelated/);
});

test('local central saves preserve roster response data and shared roster cache byte-for-byte', async () => {
  const roster = 'ROSTER_RESPONSE_ONLY\nSecond Student';
  const classes = '{"cache":"SHARED_CACHE_ONLY","revision":7}';
  const environment = loadStorage({
    [owned.roster]: roster,
    [owned.classes]: classes,
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '[]',
    [owned.localExtras]: '{"version":1,"classes":{"builtin:boys-nga":[{"id":"local:one"}]}}',
    [owned.localHidden]: '{"version":1,"classes":{"builtin:boys-nga":["local:one"]}}',
    [owned.sound]: 'on',
  });

  await environment.api.saveAttendance(
    'builtin:level-3-boys',
    environment.realm(['fabian fernandes']),
  );
  await environment.api.saveSound(false);

  assert.equal(environment.localStorage.getItem(owned.roster), roster);
  assert.equal(environment.localStorage.getItem(owned.classes), classes);
  assert.equal(environment.localStorage.getItem(owned.selected), 'builtin:level-3-boys');
  assert.equal(environment.localStorage.getItem(owned.hidden), '["fabian fernandes"]');
  assert.equal(environment.localStorage.getItem(owned.localExtras), '{"version":1,"classes":{"builtin:boys-nga":[{"id":"local:one"}]}}');
  assert.equal(environment.localStorage.getItem(owned.localHidden), '{"version":1,"classes":{"builtin:boys-nga":["local:one"]}}');
  assert.equal(environment.localStorage.getItem(owned.sound), 'off');
});

test('malformed central bytes fail closed while raw roster and cache stay untouched', async () => {
  const initial = {
    [owned.roster]: 'ROSTER_RESPONSE_ONLY',
    [owned.classes]: '{"cache":"SHARED_CACHE_ONLY"}',
    [owned.selected]: 'invalid class key',
    [owned.hidden]: '{not-json',
    [owned.sound]: 'maybe',
  };
  const environment = loadStorage(initial);

  assert.equal(environment.api.loadSelectedClassKey('builtin:level-3-boys'),
    'builtin:level-3-boys');
  assert.deepEqual(Array.from(environment.api.loadHiddenStudentKeys([])), []);
  assert.equal(environment.api.loadSound(true), true);
  assert.match(environment.api.getStorageWarning(), /backup and review/);
  await assert.rejects(
    environment.api.saveAttendance(
      'builtin:boys-nga',
      environment.realm(['kenneth chan']),
    ),
    /backup and review/,
  );
  await assert.rejects(environment.api.saveSound(false), /backup and review/);
  assert.deepEqual(environment.localStorage.snapshot(), initial);
});

test('strict validators reject inherited prototypes, accessors, duplicates, and oversized values', () => {
  const environment = loadStorage();
  const valid = environment.realm(attendance());
  environment.context.__validAttendance = valid;
  const nullPrototype = vm.runInContext(
    'Object.assign(Object.create(null), __validAttendance)',
    environment.context,
  );
  assert.equal(environment.api.validateAttendance(nullPrototype), true);

  const inherited = vm.runInContext(
    'Object.assign(Object.create({ inherited: true }), __validAttendance)',
    environment.context,
  );
  assert.equal(environment.api.validateAttendance(inherited), false);

  const accessor = vm.runInContext(`(() => {
    const value = { ...__validAttendance };
    Object.defineProperty(value, 'selectedClassKey', {
      enumerable: true,
      get() { throw new Error('must not execute'); },
    });
    return value;
  })()`, environment.context);
  assert.equal(environment.api.validateAttendance(accessor), false);
  assert.equal(environment.api.validateAttendance(environment.realm(attendance({
    hiddenStudentKeys: ['kenneth chan', 'kenneth chan'],
  }))), false);
  assert.equal(environment.api.validateAttendance(environment.realm(attendance({
    selectedClassKey: `custom:${'x'.repeat(129 * 1024)}`,
  }))), false);
  assert.equal(environment.api.validateSound(environment.realm({
    version: 1,
    enabled: 'yes',
  })), false);
});

test('both fixed-record tombstones are rejected without changing any owned key', () => {
  const initial = {
    [owned.roster]: 'ROSTER_RESPONSE_ONLY',
    [owned.classes]: '{"cache":"SHARED_CACHE_ONLY"}',
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '["kenneth chan"]',
    [owned.sound]: 'off',
  };
  const environment = loadStorage(initial);
  const adapters = environment.api.makeAdapters();

  assert.throws(
    () => adapters.attendance.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.throws(
    () => adapters.sound.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), initial);
});

test('attendance CAS race preserves newer selected and hidden values', async () => {
  const environment = loadStorage({
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '["kenneth chan"]',
  });
  let selectedReads = 0;
  let injectRace = false;
  environment.localStorage.onGet = (key, storage) => {
    if (key !== owned.selected) return;
    selectedReads += 1;
    if (injectRace && selectedReads === 2) {
      storage.values.set(owned.selected, 'builtin:advanced-boys');
      storage.values.set(owned.hidden, '["ildar bekov"]');
    }
  };
  const adapters = environment.api.makeAdapters();
  injectRace = true;

  await assert.rejects(
    adapters.attendance.applyRemote(
      environment.realm(attendance({ selectedClassKey: 'builtin:level-3-boys' })),
      remoteMetadata(false),
    ),
    /changed during an atomic update/,
  );
  assert.equal(environment.localStorage.getItem(owned.selected), 'builtin:advanced-boys');
  assert.equal(environment.localStorage.getItem(owned.hidden), '["ildar bekov"]');
});

test('rapid attendance saves coalesce to the latest value and stage once', async () => {
  const environment = loadStorage();
  const calls = [];
  environment.context.__handles = {
    attendance: { save: async (value) => calls.push(['attendance', value]) },
    sound: { save: async (value) => calls.push(['sound', value]) },
  };
  environment.api.attachHandles(
    vm.runInContext('({ ...__handles })', environment.context),
  );

  const first = environment.api.saveAttendance(
    'builtin:boys-nga',
    environment.realm(['kenneth chan']),
  );
  const latest = environment.api.saveAttendance(
    'builtin:level-3-boys',
    environment.realm(['fabian fernandes']),
  );
  await Promise.all([first, latest]);

  assert.equal(environment.localStorage.getItem(owned.selected), 'builtin:level-3-boys');
  assert.equal(environment.localStorage.getItem(owned.hidden), '["fabian fernandes"]');
  assert.equal(calls.filter(([kind]) => kind === 'attendance').length, 1);
  assert.equal(calls[0][1].selectedClassKey, 'builtin:level-3-boys');
});

test('remote attendance waits for an active action then loses to a newer local generation', async () => {
  const environment = loadStorage({
    [owned.selected]: 'builtin:boys-nga',
    [owned.hidden]: '[]',
  });
  const adapters = environment.api.makeAdapters();
  environment.api.setEditorState(
    'attendance',
    environment.realm({ active: true, dirty: true }),
  );

  let settled = false;
  const remote = adapters.attendance.applyRemote(
    environment.realm(attendance({ selectedClassKey: 'builtin:advanced-boys' })),
    remoteMetadata(false),
  ).finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  await environment.api.saveAttendance(
    'builtin:level-3-boys',
    environment.realm(['fabian fernandes']),
  );
  environment.api.setEditorState(
    'attendance',
    environment.realm({ active: false, dirty: false }),
  );

  await assert.rejects(remote, /newer local action needs review/);
  assert.equal(environment.localStorage.getItem(owned.selected), 'builtin:level-3-boys');
  assert.equal(environment.localStorage.getItem(owned.hidden), '["fabian fernandes"]');
});

test('remote sound waits for its active control and preserves the newer local toggle', async () => {
  const environment = loadStorage({ [owned.sound]: 'on' });
  const adapters = environment.api.makeAdapters();
  environment.api.setEditorState(
    'sound',
    environment.realm({ active: true, dirty: true }),
  );

  const remote = adapters.sound.applyRemote(
    environment.realm({ version: 1, enabled: true }),
    remoteMetadata(false),
  );
  await Promise.resolve();
  await environment.api.saveSound(false);
  environment.api.setEditorState(
    'sound',
    environment.realm({ active: false, dirty: false }),
  );

  await assert.rejects(remote, /newer local action needs review/);
  assert.equal(environment.localStorage.getItem(owned.sound), 'off');
});
