const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const { chromium } = require('playwright');

const root = normalize(join(__dirname, '..'));
const screenshotRoot = '/private/tmp';
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};
const syncClient = readFileSync(
  '/Users/ryansadler/Developer/ryan-app-sync/public/ryan-app-sync.js',
  'utf8',
);

const rosterAuthStub = `
(() => {
  'use strict';
  const create = () => {
    if (document.getElementById('student-shuffle-roster-auth')) return;
    const button = document.createElement('button');
    button.id = 'student-shuffle-roster-auth';
    button.type = 'button';
    button.textContent = 'Roster editing · connect';
    button.style.cssText = [
      'position:fixed', 'right:10px', 'bottom:10px', 'z-index:2147483647',
      'max-width:calc(100vw - 20px)', 'border:1px solid #14532d',
      'border-radius:999px', 'padding:7px 10px', 'background:#effbea',
      'color:#14532d', 'font:700 12px/1.2 system-ui', 'cursor:pointer'
    ].join(';');
    document.body.append(button);
  };
  window.StudentShuffleRosterAuth = Object.freeze({
    connect() {},
    getAuthHeaders() { return { Authorization: 'Bearer test-owner-token' }; },
    getWriteHeaders() { return { Authorization: 'Bearer test-owner-token' }; },
    mode: 'roster-authentication-only',
  });
  if (document.body) create();
  else document.addEventListener('DOMContentLoaded', create, { once: true });
})();
`;

const sharedRosterState = {
  version: 2,
  custom: {
    CACHE_ONLY_DO_NOT_SYNC: ['Cache Student'],
  },
  builtinOverrides: {
    'builtin:boys-nga': [
      'ROSTER_RESPONSE_ONLY',
      'Second Student',
      'Third Student',
    ],
    'builtin:level-3-boys': [
      'ROSTER_RESPONSE_ONLY',
      'Second Student',
      'Fourth Student',
    ],
  },
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/student-shuffle/' || relative === '/student-shuffle') {
      relative = '/index.html';
    } else {
      relative = relative.replace(/^\/student-shuffle/, '');
    }
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (_error) {
    response.writeHead(404);
    response.end('Not found');
  }
});

const readOutbox = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('ryan-app-sync:student-shuffle');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    const transaction = database.transaction('outbox', 'readonly');
    const all = transaction.objectStore('outbox').getAll();
    all.onerror = () => reject(all.error);
    all.onsuccess = () => resolve(all.result);
  };
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  let rosterGetCount = 0;
  let rosterPutCount = 0;

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.addInitScript(({ sharedRosterState }) => {
    if (localStorage.getItem('student-shuffle-smoke-seeded') === 'yes') return;
    localStorage.setItem('student-shuffle-smoke-seeded', 'yes');
    localStorage.setItem(
      'student-random-order-roster-v1',
      'ROSTER_RESPONSE_ONLY\\nSecond Student\\nThird Student',
    );
    localStorage.setItem(
      'student-random-order-classes-v1',
      JSON.stringify(sharedRosterState),
    );
    localStorage.setItem(
      'student-random-order-selected-class-v1',
      'builtin:boys-nga',
    );
    localStorage.setItem(
      'student-random-order-hidden-students-v1',
      '["second student"]',
    );
    localStorage.setItem('student-random-order-sound-v1', 'on');
    localStorage.setItem('another-app-secret', 'NEVER_EXPORT_THIS');
  }, { sharedRosterState });
  await page.route(
    'https://ryan-app-sync.ryan-666-mp3.chatgpt.site/ryan-app-sync.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: syncClient,
    }),
  );
  await page.route(
    'https://student-shuffle-shared.ryan-666-mp3.chatgpt.site/roster-auth.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: rosterAuthStub,
    }),
  );
  await page.route(
    'https://student-shuffle-shared.ryan-666-mp3.chatgpt.site/api/rosters',
    async (route) => {
      if (route.request().method() === 'GET') {
        rosterGetCount += 1;
        assert.equal(
          await route.request().headerValue('authorization'),
          'Bearer test-owner-token',
        );
      }
      if (route.request().method() === 'PUT') rosterPutCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: sharedRosterState, revision: 1 }),
      });
    },
  );

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/student-shuffle/`, {
      waitUntil: 'networkidle',
    });
    await page.locator('#appSyncButton[data-state]').waitFor();
    await page.locator('#student-shuffle-roster-auth').waitFor();
    await page.waitForFunction(() =>
      document.getElementById('savedMessage')?.textContent.includes('Shared class rosters'));

    assert.equal(await page.locator('#classSelect').inputValue(), 'builtin:boys-nga');
    assert.equal(
      await page.locator('.attendance-chip.is-out').allTextContents()
        .then((values) => values.some((value) => /Second Student/.test(value))),
      true,
    );
    assert.equal(await page.locator('#soundToggle').getAttribute('aria-pressed'), 'true');
    assert.equal(
      await page.evaluate(() => window.StudentShuffleRosterAuth?.mode),
      'roster-authentication-only',
    );

    await page.locator('#classSelect').selectOption('builtin:level-3-boys');
    await page.waitForFunction(() =>
      localStorage.getItem('student-random-order-selected-class-v1') ===
        'builtin:level-3-boys');
    await page.locator('.attendance-chip').filter({ hasText: 'Second Student' }).click();
    await page.waitForFunction(() =>
      localStorage.getItem('student-random-order-hidden-students-v1') ===
        '["second student"]');
    await page.locator('#soundToggle').click();
    await page.waitForFunction(() =>
      localStorage.getItem('student-random-order-sound-v1') === 'off');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() =>
      document.getElementById('savedMessage')?.textContent.includes('Shared class rosters'));
    assert.equal(await page.locator('#classSelect').inputValue(), 'builtin:level-3-boys');
    assert.equal(await page.locator('#soundToggle').getAttribute('aria-pressed'), 'false');
    assert.equal(
      await page.locator('.attendance-chip.is-out').allTextContents()
        .then((values) => values.some((value) => /Second Student/.test(value))),
      true,
    );

    const viewports = [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: 'networkidle' });
      await page.screenshot({
        path: join(screenshotRoot, `student-shuffle-page-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('#appSyncButton').click();
      await page.locator('.student-sync-dialog').waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        dialogOpen: document.querySelector('.student-sync-dialog')?.open === true,
        actions: document.querySelectorAll('.student-sync-actions button').length,
        reviewVisible:
          getComputedStyle(document.querySelector('[data-student-sync-review]')).display !== 'none',
        conflictsVisible:
          getComputedStyle(document.querySelector('[data-student-sync-conflicts]')).display !== 'none',
        warning: document.querySelector('[data-student-storage-warning]')?.textContent || '',
        rosterAuthMode: window.StudentShuffleRosterAuth?.mode,
        rosterAuthPresent: Boolean(document.getElementById('student-shuffle-roster-auth')),
      }));
      assert.equal(layout.dialogOpen, true);
      assert.equal(layout.actions, 6);
      assert.equal(layout.reviewVisible, false);
      assert.equal(layout.conflictsVisible, false);
      assert.equal(layout.warning, '');
      assert.equal(layout.rosterAuthMode, 'roster-authentication-only');
      assert.equal(layout.rosterAuthPresent, true);
      assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify({ viewport, layout }));
      await page.screenshot({
        path: join(screenshotRoot, `student-shuffle-sync-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('[data-student-sync-close]').click();
    }

    const evidence = await page.evaluate(async (readOutboxSource) => {
      const getOutbox = (0, eval)(`(${readOutboxSource})`);
      return {
        backup: window.StudentShuffleStorage.rawBackup(),
        outbox: await getOutbox(),
        roster: localStorage.getItem('student-random-order-roster-v1'),
        classes: localStorage.getItem('student-random-order-classes-v1'),
        selected: localStorage.getItem('student-random-order-selected-class-v1'),
        hidden: localStorage.getItem('student-random-order-hidden-students-v1'),
        sound: localStorage.getItem('student-random-order-sound-v1'),
      };
    }, readOutbox.toString());
    assert.deepEqual(
      Array.from(evidence.backup.records, (record) => record.key),
      [
        'student-random-order-roster-v1',
        'student-random-order-classes-v1',
        'student-random-order-selected-class-v1',
        'student-random-order-hidden-students-v1',
        'student-random-order-sound-v1',
      ],
    );
    assert.match(JSON.stringify(evidence.backup), /ROSTER_RESPONSE_ONLY|CACHE_ONLY_DO_NOT_SYNC/);
    assert.doesNotMatch(JSON.stringify(evidence.backup), /NEVER_EXPORT_THIS/);
    assert.match(evidence.roster, /ROSTER_RESPONSE_ONLY/);
    assert.match(evidence.classes, /CACHE_ONLY_DO_NOT_SYNC/);
    assert.equal(evidence.selected, 'builtin:level-3-boys');
    assert.equal(evidence.hidden, '["second student"]');
    assert.equal(evidence.sound, 'off');
    assert.deepEqual(
      [...new Set(evidence.outbox.map((item) => item.collection))].sort(),
      ['attendance', 'preferences'],
    );
    assert.doesNotMatch(
      JSON.stringify(evidence.outbox),
      /ROSTER_RESPONSE_ONLY|CACHE_ONLY_DO_NOT_SYNC/,
    );
    assert.equal(rosterPutCount, 0);
    assert.ok(rosterGetCount > 0);
    assert.equal(
      requests.some((url) => /durable-storage\.js|github-pages-origin-v1/.test(url)),
      false,
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    process.stdout.write(
      'Student Shuffle headless smoke: 375/768/1440, real client, five-key backup, central boundary, roster auth/service, persistence, zero_open PASS\n',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
