(() => {
  'use strict';

  const APP_ID = 'student-shuffle';
  const SCHEMA_VERSION = 1;
  const CHANGE_EVENT = 'student-shuffle:persistent-settings-change';
  const AGGREGATE_LOCK = 'student-shuffle:central-settings-v1';
  const STORAGE_KEYS = Object.freeze({
    roster: 'student-random-order-roster-v1',
    classes: 'student-random-order-classes-v1',
    selectedClass: 'student-random-order-selected-class-v1',
    hiddenStudents: 'student-random-order-hidden-students-v1',
    sound: 'student-random-order-sound-v1',
  });
  const RAW_BACKUP_KEYS = Object.freeze([
    STORAGE_KEYS.roster,
    STORAGE_KEYS.classes,
    STORAGE_KEYS.selectedClass,
    STORAGE_KEYS.hiddenStudents,
    STORAGE_KEYS.sound,
  ]);
  const CENTRAL_KEYS = Object.freeze([
    STORAGE_KEYS.selectedClass,
    STORAGE_KEYS.hiddenStudents,
    STORAGE_KEYS.sound,
  ]);
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_RAW_BACKUP_VALUE_BYTES = 16 * 1024 * 1024;
  const mutationStates = new Map(['attendance', 'sound'].map((group) => [group, {
    issuedGeneration: 0,
    pending: [],
    inFlightGeneration: 0,
    draining: false,
    editorActive: false,
    editorDirty: false,
    editorWaiters: new Set(),
  }]));
  const storageWarnings = { attendance: '', sound: '' };
  let handles = null;

  const stateFor = (group) => {
    const state = mutationStates.get(group);
    if (!state) throw new Error('The Student Shuffle storage group is invalid.');
    return state;
  };

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(
        new Error('Shared browser locking is unavailable. Student Shuffle settings were not changed.')
      );
    }
    return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
  };

  const dataObjectDescriptors = (value) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch (_error) {
      return null;
    }
  };

  const plainObject = (value) => Boolean(dataObjectDescriptors(value));

  const safeEntries = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map((key) => [key, descriptors[key].value])
      : null;
  };

  const safeKeys = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    return Boolean(keys &&
      keys.slice().sort().join('\u001f') === expected.slice().sort().join('\u001f'));
  };

  const safeArrayValues = (value, maximum) => {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== 'string') ||
          ownKeys.length !== value.length + 1 ||
          !descriptors.length || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch (_error) {
      return null;
    }
  };

  const jsonBytes = (value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const rawBytes = (value) => {
    try {
      return new TextEncoder().encode(value).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const validSelectedClassKey = (value) => {
    if (typeof value !== 'string' || value.length > 240 || value !== value.trim() ||
        value.includes('\u0000')) {
      return false;
    }
    if (/^builtin:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return true;
    if (!value.startsWith('custom:')) return false;
    const name = value.slice('custom:'.length);
    return Boolean(name && name.length <= 200 && name === name.trim() &&
      !/[\u0000-\u001f\u007f]/.test(name));
  };

  const normalizeHiddenStudentKeys = (value) => {
    const items = safeArrayValues(value, 500);
    if (!items) return null;
    const normalized = [];
    const seen = new Set();
    for (const item of items) {
      if (typeof item !== 'string' || item.length > 240 || item.includes('\u0000')) return null;
      const key = item.trim().toLowerCase();
      if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) return null;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(key);
    }
    return normalized;
  };

  const validateAttendance = (candidate) => {
    if (!exactKeys(candidate, ['version', 'selectedClassKey', 'hiddenStudentKeys']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const hidden = normalizeHiddenStudentKeys(value.hiddenStudentKeys);
    return value.version === SCHEMA_VERSION &&
      validSelectedClassKey(value.selectedClassKey) && Boolean(hidden) &&
      hidden.length === value.hiddenStudentKeys.length &&
      hidden.every((key, index) => key === value.hiddenStudentKeys[index]);
  };

  const canonicalAttendance = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      version: SCHEMA_VERSION,
      selectedClassKey: value.selectedClassKey,
      hiddenStudentKeys: normalizeHiddenStudentKeys(value.hiddenStudentKeys),
    };
  };

  const validateSound = (candidate) => {
    if (!exactKeys(candidate, ['version', 'enabled']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION && typeof value.enabled === 'boolean';
  };

  const canonicalSound = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return { version: SCHEMA_VERSION, enabled: value.enabled };
  };

  const readSelectedFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (!validSelectedClassKey(raw)) {
      throw new Error(
        'The selected Student Shuffle class needs an exact raw backup and review.'
      );
    }
    return raw;
  };

  const readHiddenFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (rawBytes(raw) > MAX_RECORD_BYTES) {
      throw new Error(
        'Student Shuffle attendance data is too large and needs an exact raw backup and review.'
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      throw new Error(
        'Student Shuffle attendance data needs an exact raw backup and review.'
      );
    }
    const normalized = normalizeHiddenStudentKeys(parsed);
    if (!normalized) {
      throw new Error(
        'Student Shuffle attendance data needs an exact raw backup and review.'
      );
    }
    return normalized;
  };

  const readSoundFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (!['on', 'off'].includes(raw)) {
      throw new Error(
        'The Student Shuffle sound setting needs an exact raw backup and review.'
      );
    }
    return { version: SCHEMA_VERSION, enabled: raw === 'on' };
  };

  const captureRaw = (keys) => keys.map((key) => ({
    key,
    raw: window.localStorage.getItem(key),
  }));

  const assertRawUnchanged = (snapshot, label) => {
    if (snapshot.some(({ key, raw }) => window.localStorage.getItem(key) !== raw)) {
      throw new Error(`${label} changed during an atomic update. The newer local value was preserved.`);
    }
  };

  const restoreAppliedChanges = (snapshot, changes) => {
    const originalByKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    for (const { key, raw } of changes) {
      if (window.localStorage.getItem(key) !== raw) continue;
      const original = originalByKey.get(key);
      if (original === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, original);
    }
  };

  const compareAndSet = (snapshot, changes, label) => {
    assertRawUnchanged(snapshot, label);
    try {
      for (const { key, raw } of changes) {
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      for (const { key, raw } of changes) {
        if (window.localStorage.getItem(key) !== raw) {
          throw new Error(`${label} could not be verified after writing.`);
        }
      }
    } catch (error) {
      restoreAppliedChanges(snapshot, changes);
      throw error;
    }
  };

  const readAttendanceFromSnapshot = (snapshot) => {
    const byKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    const selectedClassKey = readSelectedFromRaw(byKey.get(STORAGE_KEYS.selectedClass));
    const hiddenStudentKeys = readHiddenFromRaw(byKey.get(STORAGE_KEYS.hiddenStudents));
    if (selectedClassKey === undefined && hiddenStudentKeys === undefined) return undefined;
    if (selectedClassKey === undefined) {
      throw new Error(
        'Student Shuffle attendance data has no selected class and needs an exact raw backup and review.'
      );
    }
    return {
      version: SCHEMA_VERSION,
      selectedClassKey,
      hiddenStudentKeys: hiddenStudentKeys || [],
    };
  };

  const readAttendanceUnlocked = () => readAttendanceFromSnapshot(captureRaw([
    STORAGE_KEYS.selectedClass,
    STORAGE_KEYS.hiddenStudents,
  ]));

  const readSoundUnlocked = () =>
    readSoundFromRaw(window.localStorage.getItem(STORAGE_KEYS.sound));

  const dispatchChange = (collection, source) => {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { collection, source },
    }));
  };

  const localWorkPending = (state) =>
    Boolean(state.pending.length || state.inFlightGeneration);

  const assertConsistentRead = (group) => {
    const state = stateFor(group);
    if (localWorkPending(state) || state.editorActive || state.editorDirty) {
      throw new Error(`Local Student Shuffle ${group} changes must settle before sync can read them.`);
    }
  };

  const wakeEditorWaiters = (state) => {
    if (state.editorActive || state.editorDirty) return;
    for (const resolve of state.editorWaiters) resolve();
    state.editorWaiters.clear();
  };

  const waitForEditorIdle = (group) => {
    const state = stateFor(group);
    if (!state.editorActive && !state.editorDirty) return Promise.resolve();
    return new Promise((resolve) => state.editorWaiters.add(resolve));
  };

  const assertRemoteWritable = (group, generation) => {
    const state = stateFor(group);
    if (state.issuedGeneration !== generation || localWorkPending(state) ||
        state.editorActive || state.editorDirty) {
      throw new Error(
        `Remote Student Shuffle ${group} data was not applied because a newer local action needs review.`
      );
    }
  };

  const withConsistentRead = (group, task) => withAggregateLock(() => {
    assertConsistentRead(group);
    return task();
  });

  const withRemoteWrite = async (group, task) => {
    const state = stateFor(group);
    const generation = state.issuedGeneration;
    if (localWorkPending(state)) {
      throw new Error(
        `Remote Student Shuffle ${group} data was not applied because local work is pending.`
      );
    }
    await waitForEditorIdle(group);
    assertRemoteWritable(group, generation);
    return withAggregateLock(async () => {
      assertRemoteWritable(group, generation);
      return task(() => assertRemoteWritable(group, generation));
    });
  };

  const enqueueLatest = (group, perform) => {
    const state = stateFor(group);
    const generation = ++state.issuedGeneration;
    const promise = new Promise((resolve, reject) => {
      const pending = state.pending[0];
      if (!pending) {
        state.pending.push({
          generation,
          perform,
          waiters: [{ resolve, reject }],
        });
      } else {
        pending.generation = generation;
        pending.perform = perform;
        pending.waiters.push({ resolve, reject });
      }
    });
    if (!state.draining) {
      state.draining = true;
      Promise.resolve().then(async () => {
        try {
          while (state.pending.length) {
            const job = state.pending.shift();
            state.inFlightGeneration = job.generation;
            try {
              const result = await job.perform(job.generation);
              job.waiters.forEach(({ resolve }) => resolve(result));
            } catch (error) {
              job.waiters.forEach(({ reject }) => reject(error));
            } finally {
              state.inFlightGeneration = 0;
            }
          }
        } finally {
          state.draining = false;
        }
      });
    }
    return promise;
  };

  const setEditorState = (group, update) => {
    const state = stateFor(group);
    if (!plainObject(update)) throw new Error('The Student Shuffle editor state is invalid.');
    const value = Object.fromEntries(safeEntries(update));
    if (Object.prototype.hasOwnProperty.call(value, 'active')) {
      if (typeof value.active !== 'boolean') {
        throw new Error('The Student Shuffle editor state is invalid.');
      }
      state.editorActive = value.active;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dirty')) {
      if (typeof value.dirty !== 'boolean') {
        throw new Error('The Student Shuffle editor state is invalid.');
      }
      state.editorDirty = value.dirty;
    }
    wakeEditorWaiters(state);
  };

  const applyAttendanceUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validateAttendance(candidate)) {
      throw new Error('The synchronized Student Shuffle attendance record is invalid.');
    }
    const value = canonicalAttendance(candidate);
    const keys = [STORAGE_KEYS.selectedClass, STORAGE_KEYS.hiddenStudents];
    const snapshot = captureRaw(keys);
    readAttendanceFromSnapshot(snapshot);
    const changes = [
      { key: STORAGE_KEYS.selectedClass, raw: value.selectedClassKey },
      { key: STORAGE_KEYS.hiddenStudents, raw: JSON.stringify(value.hiddenStudentKeys) },
    ];
    assertCurrent();
    compareAndSet(snapshot, changes, 'Student Shuffle attendance settings');
    storageWarnings.attendance = '';
    dispatchChange('attendance', source);
    return true;
  };

  const applySoundUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validateSound(candidate)) {
      throw new Error('The synchronized Student Shuffle sound preference is invalid.');
    }
    const value = canonicalSound(candidate);
    const snapshot = captureRaw([STORAGE_KEYS.sound]);
    readSoundFromRaw(snapshot[0].raw);
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.sound,
      raw: value.enabled ? 'on' : 'off',
    }], 'Student Shuffle sound preference');
    storageWarnings.sound = '';
    dispatchChange('sound', source);
    return true;
  };

  const requireWriteSource = (metadata) => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = (metadata) => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid remote write source.');
    }
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata && metadata.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const localOrMigratedWrite = (group, metadata, task) => {
    requireWriteSource(metadata);
    return metadata.source === 'remote-migration'
      ? withRemoteWrite(group, task)
      : withAggregateLock(() => task(() => {}));
  };

  const makeAdapters = () => ({
    attendance: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'attendance',
      recordId: 'current',
      schemaVersion: SCHEMA_VERSION,
      validate: validateAttendance,
      readLocal: () => withConsistentRead('attendance', readAttendanceUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Student Shuffle attendance');
        return localOrMigratedWrite('attendance', metadata, (assertCurrent) =>
          applyAttendanceUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Student Shuffle attendance');
        return withRemoteWrite('attendance', (assertCurrent) =>
          applyAttendanceUnlocked(value, metadata.source, assertCurrent));
      },
    },
    sound: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'preferences',
      recordId: 'sound',
      schemaVersion: SCHEMA_VERSION,
      validate: validateSound,
      readLocal: () => withConsistentRead('sound', readSoundUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Student Shuffle sound preference');
        return localOrMigratedWrite('sound', metadata, (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Student Shuffle sound preference');
        return withRemoteWrite('sound', (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
    },
  });

  const attachHandles = (next) => {
    if (!exactKeys(next, ['attendance', 'sound'])) {
      throw new Error('Student Shuffle sync handles are incomplete.');
    }
    const value = Object.fromEntries(safeEntries(next));
    if (!value.attendance || typeof value.attendance.save !== 'function' ||
        !value.sound || typeof value.sound.save !== 'function') {
      throw new Error('Student Shuffle sync handles are incomplete.');
    }
    handles = Object.freeze({ ...value });
  };

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const saveAttendance = (selectedClassKey, hiddenStudentKeys) => {
    const candidate = {
      version: SCHEMA_VERSION,
      selectedClassKey,
      hiddenStudentKeys: Array.from(hiddenStudentKeys || []),
    };
    if (!validateAttendance(candidate)) {
      return Promise.reject(new Error('The Student Shuffle attendance settings are invalid.'));
    }
    const value = canonicalAttendance(candidate);
    return enqueueLatest('attendance', async () => {
      const previous = await withAggregateLock(() => {
        const snapshot = captureRaw([
          STORAGE_KEYS.selectedClass,
          STORAGE_KEYS.hiddenStudents,
        ]);
        const prior = readAttendanceFromSnapshot(snapshot);
        compareAndSet(snapshot, [
          { key: STORAGE_KEYS.selectedClass, raw: value.selectedClassKey },
          { key: STORAGE_KEYS.hiddenStudents, raw: JSON.stringify(value.hiddenStudentKeys) },
        ], 'Student Shuffle attendance settings');
        storageWarnings.attendance = '';
        dispatchChange('attendance', 'local');
        return prior;
      });
      if (handles && (!previous || !sameValue(previous, value))) {
        await handles.attendance.save(value);
      }
      return true;
    });
  };

  const saveSound = (enabled) => {
    const value = { version: SCHEMA_VERSION, enabled };
    if (!validateSound(value)) {
      return Promise.reject(new Error('The Student Shuffle sound preference is invalid.'));
    }
    return enqueueLatest('sound', async () => {
      let previous;
      await withAggregateLock(() => {
        const snapshot = captureRaw([STORAGE_KEYS.sound]);
        previous = readSoundFromRaw(snapshot[0].raw);
        compareAndSet(snapshot, [{
          key: STORAGE_KEYS.sound,
          raw: value.enabled ? 'on' : 'off',
        }], 'Student Shuffle sound preference');
        storageWarnings.sound = '';
        dispatchChange('sound', 'local');
      });
      if (handles && (!previous || !sameValue(previous, value))) {
        await handles.sound.save(value);
      }
      return true;
    });
  };

  const loadSelectedClassKey = (fallback = '') => {
    if (typeof fallback !== 'string') throw new Error('The selected class fallback is invalid.');
    try {
      const current = readSelectedFromRaw(window.localStorage.getItem(STORAGE_KEYS.selectedClass));
      return current === undefined ? fallback : current;
    } catch (error) {
      storageWarnings.attendance = error.message;
      return fallback;
    }
  };

  const loadHiddenStudentKeys = (fallback = []) => {
    const fallbackValues = Array.from(fallback || []);
    if (!normalizeHiddenStudentKeys(fallbackValues)) {
      throw new Error('The hidden attendance fallback is invalid.');
    }
    try {
      const current = readHiddenFromRaw(
        window.localStorage.getItem(STORAGE_KEYS.hiddenStudents)
      );
      return current === undefined ? fallbackValues : current;
    } catch (error) {
      storageWarnings.attendance = error.message;
      return fallbackValues;
    }
  };

  const loadSound = (fallback = true) => {
    if (typeof fallback !== 'boolean') throw new Error('The sound fallback is invalid.');
    try {
      const current = readSoundUnlocked();
      storageWarnings.sound = '';
      return current ? current.enabled : fallback;
    } catch (error) {
      storageWarnings.sound = error.message;
      return fallback;
    }
  };

  const assertCentralStorageValid = () => {
    readAttendanceUnlocked();
    readSoundUnlocked();
    return true;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'student_shuffle_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map((key) => {
      const rawValue = window.localStorage.getItem(key);
      if (rawValue !== null && rawBytes(rawValue) > MAX_RAW_BACKUP_VALUE_BYTES) {
        throw new Error(`The exact local value for ${key} is too large to download safely.`);
      }
      return {
        key,
        present: rawValue !== null,
        raw_value: rawValue,
      };
    }),
  });

  window.StudentShuffleStorage = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    changeEvent: CHANGE_EVENT,
    aggregateLock: AGGREGATE_LOCK,
    storageKeys: STORAGE_KEYS,
    rawBackupKeys: RAW_BACKUP_KEYS,
    centralKeys: CENTRAL_KEYS,
    rawBackup,
    validateAttendance,
    validateSound,
    makeAdapters,
    attachHandles,
    setEditorState,
    saveAttendance,
    saveSound,
    loadSelectedClassKey,
    loadHiddenStudentKeys,
    loadSound,
    assertCentralStorageValid,
    getStorageWarning: () =>
      [storageWarnings.attendance, storageWarnings.sound].filter(Boolean).join(' '),
  });
})();
