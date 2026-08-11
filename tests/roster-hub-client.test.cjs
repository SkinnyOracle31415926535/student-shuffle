const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../roster-hub-client.js', `file://${__filename}`),
  'utf8',
);
const appHtml = readFileSync(
  new URL('../index.html', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function loadClient(initial = {}, fetchImpl = async () => {
  throw new Error('unexpected fetch');
}, location = { hash: '', pathname: '/', search: '' }) {
  const localStorage = new FakeStorage(initial);
  const window = {
    localStorage,
    crypto: {
      randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef',
    },
    fetch: fetchImpl,
    location,
    history: {
      replaceState: (_state, _title, path) => {
        location.replacedPath = path;
      },
    },
  };
  const context = vm.createContext({ window, URL, URLSearchParams, Uint32Array, Date, JSON, console });
  new vm.Script(source, { filename: 'roster-hub-client.js' }).runInContext(context);
  return { api: window.StudentShuffleRosterHub, localStorage, window };
}

test('official rows are validated, grouped by Student Shuffle key, and preserve member IDs', () => {
  const { api } = loadClient();
  const snapshot = api.parseOfficialRosterRows([
    {
      source_revision: 4,
      published_at: '2026-08-11T17:00:00.000Z',
      class_key: 'level-3-boys',
      lesson_plan_class: 'Level 3 Boys',
      app_keys: { 'student-shuffle': 'builtin:level-3-boys' },
      student_key: 'l3-fabian',
      display_name: 'Fabian Fernandes',
      ordinal: 2,
    },
    {
      source_revision: 4,
      published_at: '2026-08-11T17:00:00.000Z',
      class_key: 'level-3-boys',
      lesson_plan_class: 'Level 3 Boys',
      app_keys: { 'student-shuffle': 'builtin:level-3-boys' },
      student_key: 'l3-ethan',
      display_name: 'Ethan Grinberg',
      ordinal: 1,
    },
  ]);

  assert.equal(snapshot.revision, 4);
  assert.deepEqual(
    Array.from(snapshot.classes[0].members, (member) => [member.id, member.displayName]),
    [['l3-ethan', 'Ethan Grinberg'], ['l3-fabian', 'Fabian Fernandes']],
  );
  assert.throws(() => api.parseOfficialRosterRows([
    { ...snapshot.classes[0], source_revision: 4 },
  ]), /invalid official roster/);
});

test('Roster Hub is preconfigured for this private project on a new device', () => {
  const { api } = loadClient();
  const config = api.loadConfig();
  assert.equal(config.projectUrl, 'https://cojrcavdfdusjdtqajwk.supabase.co');
  assert.match(config.publishableKey, /^sb_publishable_/);
});

test('an invitation callback creates a device session, clears its URL secret, and accepts a password', async () => {
  const calls = [];
  const location = {
    hash: '#access_token=one-time-access&expires_in=3600&refresh_token=one-time-refresh&type=invite',
    pathname: '/student-shuffle',
    search: '',
  };
  const { api, localStorage } = loadClient({}, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('grant_type=refresh_token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          user: { id: '00000000-0000-0000-0000-000000000002' },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }, location);

  assert.equal(await api.acceptInviteRedirect(), true);
  assert.equal(location.hash, '');
  assert.equal(location.replacedPath, '/student-shuffle');
  assert.equal(api.hasPendingInvite(), true);
  assert.match(localStorage.getItem(api.sessionKey), /fresh-access-token/);

  await api.setPassword('private-roster-password');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'PUT');
  assert.match(calls[1].url, /\/auth\/v1\/user$/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh-access-token');
  assert.equal(api.hasPendingInvite(), false);
});

test('an app-created student is a browser-local extra and never changes the official snapshot', () => {
  const { api, localStorage } = loadClient();
  const official = [{ id: 'vault-fabian', displayName: 'Fabian Fernandes', official: true, local: false }];
  const result = api.addLocalExtra('builtin:level-3-boys', ' Local Student ', official);
  assert.equal(result.added, true);
  assert.deepEqual(
    Array.from(api.loadLocalExtras('builtin:level-3-boys'), (member) => [member.id, member.displayName, member.local]),
    [['local:01234567-89ab-cdef-0123-456789abcdef', 'Local Student', true]],
  );
  assert.equal(localStorage.getItem(api.cacheKey), null);
  assert.equal(api.addLocalExtra('builtin:level-3-boys', 'fabian fernandes', official).added, false);
  assert.equal(api.removeLocalExtra('builtin:level-3-boys', result.member.id), true);
  assert.deepEqual(Array.from(api.loadLocalExtras('builtin:level-3-boys')), []);
  assert.equal(api.removeLocalExtra('builtin:level-3-boys', result.member.id), false);
});

test('a local student whose name later becomes official is not duplicated or merged', () => {
  const { api } = loadClient();
  const merged = api.mergeMembers(
    [{ id: 'vault-student', displayName: 'New Student', official: true, local: false }],
    [{ id: 'local:one', displayName: 'New Student', official: false, local: true }],
  );
  assert.deepEqual(
    Array.from(merged.members, (member) => member.id),
    ['vault-student'],
  );
  assert.deepEqual(
    Array.from(merged.conflicts, (member) => member.id),
    ['local:one'],
  );
});

test('official roster loading uses an authenticated GET and only updates the official cache after validation', async () => {
  const calls = [];
  const { api, localStorage } = loadClient({
    'student-shuffle-roster-hub-config-v2': JSON.stringify({
      version: 1,
      projectUrl: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_example',
    }),
    'student-shuffle-roster-hub-session-v1': JSON.stringify({
      version: 1,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      userId: '00000000-0000-0000-0000-000000000001',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
  }, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => [{
        source_revision: 7,
        published_at: '2026-08-11T17:00:00.000Z',
        class_key: 'boys-nga',
        lesson_plan_class: 'Boys NGA',
        app_keys: { 'student-shuffle': 'builtin:boys-nga' },
        student_key: 'nga-maxon',
        display_name: 'Maxon Edington',
        ordinal: 1,
      }],
    };
  });

  const result = await api.loadOfficialRoster();
  assert.equal(result.snapshot.revision, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/example\.supabase\.co\/rest\/v1\/official_roster_current\?/);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(calls[0].options.headers.apikey, 'sb_publishable_example');
  assert.doesNotMatch(calls[0].url, /api\/rosters|student-shuffle-shared/);
  assert.match(localStorage.getItem(api.cacheKey), /nga-maxon/);
});

test('local hidden attendance remains in a separate browser-only record', () => {
  const { api, localStorage } = loadClient();
  api.saveLocalHiddenStudentKeys('builtin:level-3-boys', ['local:one', 'local:one']);
  assert.deepEqual(Array.from(api.loadLocalHiddenStudentKeys('builtin:level-3-boys')), ['local:one']);
  assert.equal(localStorage.getItem('student-random-order-hidden-students-v1'), null);
});

test('Student Shuffle no longer loads or writes the legacy shared roster endpoint', () => {
  assert.match(appHtml, /<script src="roster-hub-client\.js"><\/script>/);
  assert.match(appHtml, /StudentShuffleRosterHub\.addLocalExtra/);
  assert.doesNotMatch(appHtml, /student-shuffle-shared|\/api\/rosters|roster-auth\.js/);
});
