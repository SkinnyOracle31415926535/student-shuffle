(() => {
  'use strict';

  const migrationGate = (preview) => {
    if (!preview || !Number.isInteger(preview.writesPerformed) ||
        !Number.isInteger(preview.remoteCount) ||
        !Number.isInteger(preview.orphanedCount) ||
        preview.writesPerformed < 0 || preview.remoteCount < 0 ||
        preview.orphanedCount < 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview counts are invalid.',
      };
    }
    if (preview.writesPerformed !== 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview performed writes.',
      };
    }
    if (preview.remoteCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.remoteCount} synchronized remote record` +
          `${preview.remoteCount === 1 ? '' : 's'} already exist.`,
      };
    }
    if (preview.orphanedCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.orphanedCount} orphaned local sync intent` +
          `${preview.orphanedCount === 1 ? '' : 's'} need review.`,
      };
    }
    return {
      safe: true,
      message: 'Preview confirmed: 0 writes, 0 remote records, and 0 orphaned intents.',
    };
  };

  const requireSafeMigration = (preview) => {
    const gate = migrationGate(preview);
    if (!gate.safe) throw new Error(gate.message);
    return true;
  };

  window.StudentShuffleSyncPolicy = Object.freeze({ migrationGate, requireSafeMigration });

  const store = window.StudentShuffleStorage;
  const openButton = document.getElementById('appSyncButton');
  if (!document.body || !openButton || !store) return;

  openButton.disabled = false;
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'Sync & backup';
  openButton.setAttribute('aria-label', 'Open Student Shuffle sync and backup');

  const dialog = document.createElement('dialog');
  dialog.className = 'student-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'student-sync-title');
  dialog.innerHTML = `
    <div class="student-sync-window">
      <div class="student-sync-heading">
        <div>
          <p class="student-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="student-sync-title">Sync &amp; backup</h2>
        </div>
        <button type="button" class="student-sync-close" data-student-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="student-sync-copy">
        The selected class, today’s hidden-attendance list, and sound preference can sync
        between Ryan’s browsers.
      </p>
      <p class="student-sync-safety">
        Full rosters, current-class response data, and the shared roster cache never become
        central records. Only names marked hidden today are part of the attendance setting.
        The exact local backup includes all five Student Shuffle keys for recovery.
      </p>
      <p class="student-sync-roster-note">
        Roster editing remains a separate connection through the existing roster service.
      </p>
      <div class="student-sync-state" data-student-sync-state data-state="disconnected">
        <strong data-student-sync-state-label>Disconnected</strong>
        <span data-student-sync-state-message>Student Shuffle settings stay on this device.</span>
      </div>
      <p class="student-sync-alert" data-student-sync-alert role="alert" hidden></p>
      <div class="student-sync-actions">
        <button type="button" class="is-primary" data-student-sync-connect data-sync-action>
          Connect as Ryan
        </button>
        <button type="button" data-student-sync-now data-sync-action>Sync now</button>
        <button type="button" data-student-sync-backup data-sync-action>
          Download exact local backup
        </button>
        <button type="button" data-student-sync-preview data-sync-action>
          Create backup &amp; preview
        </button>
        <button type="button" data-student-sync-disconnect data-sync-action>Disconnect</button>
        <button type="button" data-student-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="student-sync-review" data-student-sync-review hidden
        aria-labelledby="student-sync-review-title">
        <h3 id="student-sync-review-title">Migration preview</h3>
        <p data-student-sync-counts></p>
        <p class="student-sync-zero-write" data-student-sync-zero-write></p>
        <div class="student-sync-records" data-student-sync-records></div>
        <button type="button" class="is-primary" data-student-sync-apply
          data-sync-action disabled>Apply reviewed migration</button>
      </section>
      <section class="student-sync-conflicts" data-student-sync-conflicts hidden
        aria-labelledby="student-sync-conflicts-title">
        <h3 id="student-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose each result deliberately. No choice is made automatically.</p>
        <div class="student-sync-conflict-list" data-student-sync-conflict-list></div>
      </section>
      <p class="student-sync-footnote">
        Resetting this connection never deletes local Student Shuffle keys or shared rosters.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-student-sync-close]');
  const connectButton = dialog.querySelector('[data-student-sync-connect]');
  const syncButton = dialog.querySelector('[data-student-sync-now]');
  const backupButton = dialog.querySelector('[data-student-sync-backup]');
  const previewButton = dialog.querySelector('[data-student-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-student-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-student-sync-reset]');
  const applyButton = dialog.querySelector('[data-student-sync-apply]');
  const stateBox = dialog.querySelector('[data-student-sync-state]');
  const stateLabel = dialog.querySelector('[data-student-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-student-sync-state-message]');
  const alert = dialog.querySelector('[data-student-sync-alert]');
  const review = dialog.querySelector('[data-student-sync-review]');
  const counts = dialog.querySelector('[data-student-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-student-sync-zero-write]');
  const records = dialog.querySelector('[data-student-sync-records]');
  const conflicts = dialog.querySelector('[data-student-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-student-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let restoreFocus = null;

  const stateLabels = {
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  };

  const buttonLabels = {
    disconnected: 'Sync & backup',
    review: 'Review sync',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline backup',
    conflict: 'Resolve sync',
  };

  const showAlert = (message = '') => {
    alert.hidden = !message;
    alert.textContent = message;
  };

  const showStorageWarning = (message = '') => {
    const current = document.querySelector('[data-student-storage-warning]');
    if (!message) {
      current?.remove();
      return;
    }
    const warning = current || document.createElement('p');
    warning.className = 'student-storage-warning';
    warning.dataset.studentStorageWarning = '';
    warning.setAttribute('role', 'alert');
    warning.textContent = `${message} Download the exact local backup before changing these settings.`;
    if (!current) document.querySelector('.titlebar')?.after(warning);
    showAlert(message);
  };

  window.StudentShuffleSync = Object.freeze({
    showStorageWarning,
    rawBackup: () => store.rawBackup(),
  });

  const setBusy = (next) => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach((button) => {
      button.disabled = next || (button === applyButton && !previewResult);
    });
    if (!next) {
      applyButton.disabled = !previewResult ||
        !migrationGate(previewResult.preview).safe;
    }
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `student-shuffle-browser-local-raw-backup-${today}.json`,
    );
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const makeReviewRow = (item) => {
    const row = document.createElement('div');
    row.className = 'student-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = `${item.collection} · ${item.recordId}`;
    const status = document.createElement('span');
    status.textContent = String(item.status || '').replaceAll('-', ' ');
    row.append(identity, status);
    return row;
  };

  const renderPreview = (result) => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · ` +
      `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · ` +
      `${result.preview.orphanedCount} orphaned`;
    const gate = migrationGate(result.preview);
    zeroWrite.textContent = gate.message;
    zeroWrite.dataset.safe = String(gate.safe);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    applyButton.disabled = busy || !gate.safe;
  };

  const conflictRecordLabel = (item) => {
    const parts = String(item.recordKey || '').split('\u001f');
    return parts.length === 4 ? `${parts[2]} · ${parts[3]}` : 'Student Shuffle record';
  };

  const resolveConflict = async (item, strategy) => {
    if (!client) return;
    setBusy(true);
    showAlert('');
    try {
      await client.resolveConflict(item.recordKey, {
        strategy,
        expectedRemoteRevision: Number.isSafeInteger(item.current?.revision)
          ? item.current.revision
          : 0,
      });
      await renderConflicts();
    } catch (error) {
      showAlert(error.message || 'That conflict could not be resolved. Local data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  const makeConflictRow = (item) => {
    const row = document.createElement('div');
    row.className = 'student-sync-conflict';
    const identity = document.createElement('strong');
    identity.textContent = conflictRecordLabel(item);
    const reason = document.createElement('span');
    reason.textContent = `Reason: ${String(item.reason || 'record conflict').replaceAll('-', ' ')}`;
    const actions = document.createElement('div');
    actions.className = 'student-sync-conflict-actions';
    const localButton = document.createElement('button');
    localButton.type = 'button';
    localButton.textContent = 'Keep this device';
    localButton.addEventListener('click', () => void resolveConflict(item, 'keep-local'));
    const remoteButton = document.createElement('button');
    remoteButton.type = 'button';
    remoteButton.textContent = 'Use synchronized record';
    remoteButton.addEventListener('click', () => void resolveConflict(item, 'accept-remote'));
    actions.append(localButton, remoteButton);
    row.append(identity, reason, actions);
    return row;
  };

  const renderConflicts = async () => {
    if (!client) return;
    const items = await client.listConflicts();
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren(...items.map(makeConflictRow));
  };

  const renderState = (next) => {
    const mode = next?.mode || 'disconnected';
    openButton.dataset.state = mode;
    openButton.textContent = buttonLabels[mode] || 'Sync & backup';
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent = next?.message || 'Student Shuffle settings stay on this device.';
    if (mode === 'conflict') void renderConflicts();
    else if (mode !== 'offline') showAlert('');
  };

  const runAction = async (task) => {
    if (!initialized || busy) return;
    setBusy(true);
    showAlert('');
    try {
      await task();
    } catch (error) {
      showAlert(error.message || 'The action did not finish. Local settings were preserved.');
    } finally {
      setBusy(false);
    }
  };

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    showStorageWarning(store.getStorageWarning());
    void renderConflicts();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => void runAction(() => client.connect()));
  syncButton.addEventListener('click', () => void runAction(() => client.sync()));
  backupButton.addEventListener('click', () => {
    try {
      downloadRawBackup();
      showAlert('');
    } catch (error) {
      showAlert(error.message || 'The exact local backup could not be created.');
    }
  });
  previewButton.addEventListener('click', () => void runAction(async () => {
    store.assertCentralStorageValid();
    downloadRawBackup();
    const result = await client.previewMigration({ downloadBackup: true });
    renderPreview(result);
  }));
  applyButton.addEventListener('click', () => void runAction(async () => {
    if (!previewResult) throw new Error('Create a fresh migration preview first.');
    requireSafeMigration(previewResult.preview);
    await client.applyMigration(previewResult.plan, {});
    invalidatePreview();
  }));
  disconnectButton.addEventListener('click', () => void runAction(async () => {
    await client.disconnect();
    invalidatePreview();
  }));
  resetButton.addEventListener('click', () => void runAction(async () => {
    await client.resetDevice();
    invalidatePreview();
  }));

  const initialize = async () => {
    if (!window.RyanAppSync || typeof window.RyanAppSync.create !== 'function') {
      throw new Error('Ryan App Sync did not load. Student Shuffle settings remain local.');
    }
    client = window.RyanAppSync.create({
      appId: store.appId,
      manifestVersion: 1,
      serviceOrigin: 'https://ryan-app-sync.ryan-666-mp3.chatgpt.site',
    });
    client.onStateChange(renderState);
    const adapters = store.makeAdapters();
    const attendance = await client.register(adapters.attendance);
    const sound = await client.register(adapters.sound);
    store.attachHandles({ attendance, sound });
    await client.finalizeRegistration();
    initialized = true;
    setBusy(false);
    showStorageWarning(store.getStorageWarning());
  };

  setBusy(true);
  void initialize().catch((error) => {
    showAlert(error.message || 'App sync could not initialize. Student Shuffle settings remain local.');
    openButton.dataset.state = 'offline';
    openButton.textContent = 'Offline backup';
    stateBox.dataset.state = 'offline';
    stateLabel.textContent = 'Sync unavailable';
    stateMessage.textContent = 'Student Shuffle settings remain only on this device.';
    Array.from(dialog.querySelectorAll('[data-sync-action]'))
      .forEach((button) => { button.disabled = true; });
  });
})();
