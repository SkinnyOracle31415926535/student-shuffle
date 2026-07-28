const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const syncSource = readFileSync(
  new URL('../student-shuffle-sync.js', `file://${__filename}`),
  'utf8',
);
const storageSource = readFileSync(
  new URL('../student-shuffle-storage.js', `file://${__filename}`),
  'utf8',
);
const html = readFileSync(
  new URL('../index.html', `file://${__filename}`),
  'utf8',
);

const loadPolicy = () => {
  const window = {};
  const document = {
    body: null,
    getElementById() {
      return null;
    },
  };
  new vm.Script(syncSource, { filename: 'student-shuffle-sync.js' })
    .runInNewContext({ window, document, Number, Object });
  return window.StudentShuffleSyncPolicy;
};

test('migration gate requires zero writes, remote records, and orphaned intents', () => {
  const policy = loadPolicy();
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, true);
  assert.equal(policy.migrationGate({
    writesPerformed: 1,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 1,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 1,
  }).safe, false);
  assert.equal(policy.migrationGate({}).safe, false);
});

test('central manifest excludes roster response and class-cache keys', () => {
  assert.match(storageSource, /collection: 'attendance'/);
  assert.match(storageSource, /collection: 'preferences'/);
  assert.match(storageSource, /recordId: 'current'/);
  assert.match(storageSource, /recordId: 'sound'/);
  assert.doesNotMatch(storageSource, /Storage\.prototype|localStorage\.clear\s*\(/);
  assert.doesNotMatch(storageSource, /localStorage\.(?:key|length)\b/);
  assert.doesNotMatch(storageSource, /for\s*\([^)]*\bin\s+window\.localStorage/);
  const adapterBlock = storageSource.match(
    /const makeAdapters = \(\) => \(\{[\s\S]*?\n  \}\);/,
  )?.[0] || '';
  assert.doesNotMatch(
    adapterBlock,
    /STORAGE_KEYS\.(?:roster|classes)|student-random-order-(?:roster|classes)-v1/,
  );
  assert.match(html,
    /student-shuffle-shared\.ryan-666-mp3\.chatgpt\.site\/roster-auth\.js/);
  assert.match(html, /StudentShuffleRosterAuth\?\.getAuthHeaders\?\.\(\)/);
  assert.match(html, /StudentShuffleRosterAuth\?\.getWriteHeaders\?\.\(\)/);
  assert.match(html, /fetch\(SHARED_ROSTER_API_URL,\s*\{[\s\S]*headers:\s*rosterHeaders/);
  assert.match(html, /student-shuffle-roster-authenticated/);
  assert.match(html, /student-shuffle-storage\.js/);
  assert.match(html, /ryan-app-sync[^"']*\/ryan-app-sync\.js/);
  assert.match(html, /student-shuffle-sync\.js/);
});

test('migration UI downloads five-key raw backup before metadata preview', () => {
  const previewHandler = syncSource.match(
    /previewButton\.addEventListener\('click',[\s\S]*?\n  \}\)\);/,
  )?.[0] || '';
  assert.match(previewHandler, /store\.assertCentralStorageValid\(\)/);
  assert.match(previewHandler, /downloadRawBackup\(\)/);
  assert.match(previewHandler, /client\.previewMigration\(\{ downloadBackup: true \}\)/);
  assert.ok(
    previewHandler.indexOf('downloadRawBackup()') <
    previewHandler.indexOf('client.previewMigration'),
  );
  assert.match(storageSource,
    /RAW_BACKUP_KEYS = Object\.freeze\(\[[\s\S]*STORAGE_KEYS\.roster[\s\S]*STORAGE_KEYS\.classes/);
});
