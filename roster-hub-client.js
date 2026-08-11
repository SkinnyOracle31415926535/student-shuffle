(() => {
  "use strict";

  const CONFIG_KEY = "student-shuffle-roster-hub-config-v2";
  const SESSION_KEY = "student-shuffle-roster-hub-session-v1";
  const PENDING_INVITE_KEY = "student-shuffle-roster-hub-pending-invite-v1";
  const CACHE_KEY = "student-shuffle-roster-hub-official-cache-v1";
  const LOCAL_EXTRAS_KEY = "student-random-order-local-extras-v1";
  const LOCAL_HIDDEN_KEY = "student-random-order-local-hidden-students-v1";
  const CACHE_VERSION = 1;
  const DEFAULT_CONFIG = Object.freeze({
    version: CACHE_VERSION,
    projectUrl: "https://cojrcavdfdusjdtqajwk.supabase.co",
    publishableKey: "sb_publishable_-mPsLb0mQl9nn1DyKh3HfQ_XQUZ_fGl"
  });
  const SESSION_REFRESH_MARGIN_MS = 60_000;
  const MAX_TEXT_LENGTH = 240;

  const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const cleanText = (value, maximum = MAX_TEXT_LENGTH) => {
    if (typeof value !== "string") return "";
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
    return normalized;
  };

  function readJson(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function normalizeProjectUrl(value) {
    const text = cleanText(value, 500);
    if (!text) return "";
    try {
      const url = new URL(text);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
      return url.origin;
    } catch (_error) {
      return "";
    }
  }

  function normalizeConfig(value) {
    if (!plainObject(value)) return null;
    const projectUrl = normalizeProjectUrl(value.projectUrl);
    const publishableKey = cleanText(value.publishableKey, 4_096);
    if (!projectUrl || !publishableKey) return null;
    return { version: CACHE_VERSION, projectUrl, publishableKey };
  }

  function loadConfig() {
    return normalizeConfig(readJson(CONFIG_KEY)) || DEFAULT_CONFIG;
  }

  function saveConfig(value) {
    const config = normalizeConfig(value);
    if (!config || !writeJson(CONFIG_KEY, config)) {
      throw new Error("Roster Hub settings could not be saved on this device.");
    }
    return config;
  }

  function normalizeSession(value) {
    if (!plainObject(value)) return null;
    const accessToken = cleanText(value.accessToken, 16_384);
    const refreshToken = cleanText(value.refreshToken, 16_384);
    const userId = cleanText(value.userId, 240);
    if (!accessToken || !refreshToken || !userId || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return null;
    return { version: CACHE_VERSION, accessToken, refreshToken, userId, expiresAt: value.expiresAt };
  }

  function loadSession() {
    return normalizeSession(readJson(SESSION_KEY));
  }

  function saveSession(value) {
    const session = normalizeSession(value);
    if (!session || !writeJson(SESSION_KEY, session)) {
      throw new Error("Roster Hub sign-in could not be saved on this device.");
    }
    return session;
  }

  function clearSession() {
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch (_error) {
      // The next successful sign-in can replace a storage entry that cannot be removed now.
    }
    clearPendingInvite();
  }

  function hasPendingInvite() {
    const value = readJson(PENDING_INVITE_KEY);
    return plainObject(value) && value.version === CACHE_VERSION && value.pending === true;
  }

  function savePendingInvite() {
    if (!writeJson(PENDING_INVITE_KEY, { version: CACHE_VERSION, pending: true })) {
      throw new Error("The roster invitation could not be saved on this device.");
    }
  }

  function clearPendingInvite() {
    try {
      window.localStorage.removeItem(PENDING_INVITE_KEY);
    } catch (_error) {
      // A successful password setup can still replace this state on the next visit.
    }
  }

  function sessionFromAuthPayload(value) {
    if (!plainObject(value) || !plainObject(value.user)) return null;
    const accessToken = cleanText(value.access_token, 16_384);
    const refreshToken = cleanText(value.refresh_token, 16_384);
    const userId = cleanText(value.user.id, 240);
    const expiresIn = Number(value.expires_in);
    if (!accessToken || !refreshToken || !userId || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    return {
      version: CACHE_VERSION,
      accessToken,
      refreshToken,
      userId,
      expiresAt: Date.now() + Math.floor(expiresIn * 1_000)
    };
  }

  async function requestJson(url, options) {
    let response;
    try {
      response = await window.fetch(url, options);
    } catch (_error) {
      throw new Error("Roster Hub is unavailable right now.");
    }
    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      // A generic error below keeps credential and roster details out of the UI.
    }
    return { response, body };
  }

  async function signIn(email, password) {
    const config = loadConfig();
    const normalizedEmail = cleanText(email, 320);
    if (!config) throw new Error("Save the Roster Hub project URL and public key first.");
    if (!normalizedEmail || typeof password !== "string" || !password) {
      throw new Error("Enter the Roster Hub email and password.");
    }
    const { response, body } = await requestJson(
      `${config.projectUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: normalizedEmail, password })
      }
    );
    const session = sessionFromAuthPayload(body);
    if (!response.ok || !session) throw new Error("Roster Hub sign-in was not accepted.");
    return saveSession(session);
  }

  async function refreshSession(session = loadSession()) {
    const config = loadConfig();
    if (!config || !session) throw new Error("Sign in to Roster Hub first.");
    if (session.expiresAt > Date.now() + SESSION_REFRESH_MARGIN_MS) return session;
    const { response, body } = await requestJson(
      `${config.projectUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ refresh_token: session.refreshToken })
      }
    );
    const refreshed = sessionFromAuthPayload(body);
    if (!response.ok || !refreshed) {
      clearSession();
      throw new Error("Roster Hub sign-in expired. Sign in again.");
    }
    return saveSession(refreshed);
  }

  function clearAuthCallbackHash() {
    const location = window.location;
    if (!location) return;
    const cleanPath = `${location.pathname || "/"}${location.search || ""}`;
    if (typeof window.history?.replaceState === "function") {
      window.history.replaceState(null, "", cleanPath);
    }
    location.hash = "";
  }

  async function acceptInviteRedirect() {
    const hash = typeof window.location?.hash === "string" ? window.location.hash : "";
    if (!hash) return false;
    const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const callbackType = parameters.get("type");
    if (callbackType !== "invite" && callbackType !== "recovery") return false;
    const refreshToken = cleanText(parameters.get("refresh_token"), 16_384);
    clearAuthCallbackHash();
    if (!refreshToken) throw new Error("The roster invitation could not be completed. Use a new invitation link.");

    const config = loadConfig();
    const { response, body } = await requestJson(
      `${config.projectUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      }
    );
    const session = sessionFromAuthPayload(body);
    if (!response.ok || !session) throw new Error("The roster invitation could not be completed. Use a new invitation link.");
    saveSession(session);
    savePendingInvite();
    return true;
  }

  async function setPassword(password) {
    if (typeof password !== "string" || !password) {
      throw new Error("Choose a Roster Hub password first.");
    }
    const config = loadConfig();
    const session = await refreshSession();
    const { response } = await requestJson(
      `${config.projectUrl}/auth/v1/user`,
      {
        method: "PUT",
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
      }
    );
    if (!response.ok) throw new Error("Roster Hub could not save that password.");
    clearPendingInvite();
    return session;
  }

  function normalizeMember(value) {
    if (!plainObject(value)) return null;
    const id = cleanText(value.id, MAX_TEXT_LENGTH);
    const displayName = cleanText(value.displayName, 160);
    if (!id || !displayName) return null;
    return { id, displayName, official: Boolean(value.official), local: Boolean(value.local) };
  }

  function normalizeOfficialSnapshot(value) {
    if (!plainObject(value) || value.version !== CACHE_VERSION ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        !cleanText(value.updatedAt, 80) || !Array.isArray(value.classes)) {
      return null;
    }
    const classKeys = new Set();
    const classes = [];
    for (const entry of value.classes) {
      if (!plainObject(entry)) return null;
      const key = cleanText(entry.key);
      const canonicalKey = cleanText(entry.canonicalKey);
      const name = cleanText(entry.name, 160);
      if (!key || !canonicalKey || !name || classKeys.has(key) || !Array.isArray(entry.members)) return null;
      const memberIds = new Set();
      const members = [];
      for (const member of entry.members) {
        const normalized = normalizeMember({ ...member, official: true, local: false });
        if (!normalized || memberIds.has(normalized.id)) return null;
        memberIds.add(normalized.id);
        members.push(normalized);
      }
      classKeys.add(key);
      classes.push({ key, canonicalKey, name, members });
    }
    return { version: CACHE_VERSION, revision: value.revision, updatedAt: value.updatedAt, classes };
  }

  function loadCachedOfficialRoster() {
    return normalizeOfficialSnapshot(readJson(CACHE_KEY));
  }

  function cacheOfficialRoster(value) {
    const snapshot = normalizeOfficialSnapshot(value);
    if (!snapshot || !writeJson(CACHE_KEY, snapshot)) {
      throw new Error("The official roster cache could not be saved on this device.");
    }
    return snapshot;
  }

  function parseOfficialRosterRows(value) {
    if (!Array.isArray(value)) throw new Error("Roster Hub returned an invalid official roster.");
    if (!value.length) return null;
    const classes = new Map();
    let revision = null;
    let updatedAt = null;
    for (const row of value) {
      if (!plainObject(row) || !Number.isSafeInteger(row.source_revision) || row.source_revision < 1 ||
          !cleanText(row.published_at, 80) || !cleanText(row.class_key) ||
          !cleanText(row.lesson_plan_class, 160) || !plainObject(row.app_keys) ||
          !cleanText(row.student_key) || !cleanText(row.display_name, 160) ||
          !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) {
        throw new Error("Roster Hub returned an invalid official roster.");
      }
      const key = cleanText(row.app_keys["student-shuffle"]);
      if (!key) continue;
      if (revision === null) {
        revision = row.source_revision;
        updatedAt = row.published_at;
      }
      if (revision !== row.source_revision || updatedAt !== row.published_at) {
        throw new Error("Roster Hub returned mixed roster revisions.");
      }
      let classEntry = classes.get(key);
      if (!classEntry) {
        classEntry = {
          key,
          canonicalKey: row.class_key,
          name: row.lesson_plan_class,
          members: []
        };
        classes.set(key, classEntry);
      }
      if (classEntry.canonicalKey !== row.class_key || classEntry.name !== row.lesson_plan_class ||
          classEntry.members.some((member) => member.id === row.student_key)) {
        throw new Error("Roster Hub returned an invalid official roster.");
      }
      classEntry.members.push({ id: row.student_key, displayName: row.display_name, official: true, local: false, ordinal: row.ordinal });
    }
    if (!classes.size) return null;
    const snapshot = {
      version: CACHE_VERSION,
      revision,
      updatedAt,
      classes: Array.from(classes.values()).map((entry) => ({
        ...entry,
        members: entry.members.sort((left, right) => left.ordinal - right.ordinal).map(({ ordinal, ...member }) => member)
      }))
    };
    return normalizeOfficialSnapshot(snapshot);
  }

  async function loadOfficialRoster() {
    const config = loadConfig();
    if (!config) throw new Error("Connect Roster Hub to load official rosters.");
    let session = await refreshSession();
    const parameters = new URLSearchParams({
      select: "source_revision,published_at,class_key,lesson_plan_class,app_keys,student_key,display_name,ordinal",
      order: "class_key.asc,ordinal.asc"
    });
    const request = () => requestJson(
      `${config.projectUrl}/rest/v1/official_roster_student_shuffle_current?${parameters.toString()}`,
      {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${session.accessToken}`,
          Accept: "application/json"
        }
      }
    );
    let result = await request();
    if (result.response.status === 401) {
      session = await refreshSession({ ...session, expiresAt: 0 });
      result = await request();
    }
    if (!result.response.ok) {
      if (result.response.status === 401) {
        clearSession();
        throw new Error("Roster Hub sign-in expired. Sign in again.");
      }
      if (result.response.status === 403) {
        throw new Error("This Roster Hub account is not allowed to read the official roster.");
      }
      throw new Error(`Official roster request failed (${result.response.status}).`);
    }
    const snapshot = parseOfficialRosterRows(result.body);
    if (!snapshot) return { snapshot: null, changed: false };
    const prior = loadCachedOfficialRoster();
    cacheOfficialRoster(snapshot);
    return { snapshot, changed: !prior || prior.revision !== snapshot.revision };
  }

  function normalizeExtras(value) {
    if (!plainObject(value) || value.version !== CACHE_VERSION || !plainObject(value.classes)) {
      return { version: CACHE_VERSION, classes: {} };
    }
    const classes = {};
    for (const [classKey, entries] of Object.entries(value.classes)) {
      const normalizedClassKey = cleanText(classKey);
      if (!normalizedClassKey || !Array.isArray(entries)) continue;
      const ids = new Set();
      const names = new Set();
      const result = [];
      for (const entry of entries) {
        const member = normalizeMember({ ...entry, local: true, official: false });
        if (!member || ids.has(member.id) || names.has(member.displayName.toLowerCase())) continue;
        ids.add(member.id);
        names.add(member.displayName.toLowerCase());
        result.push(member);
      }
      if (result.length) classes[normalizedClassKey] = result;
    }
    return { version: CACHE_VERSION, classes };
  }

  function loadLocalExtras(classKey) {
    const key = cleanText(classKey);
    if (!key) return [];
    return normalizeExtras(readJson(LOCAL_EXTRAS_KEY)).classes[key] || [];
  }

  function localId() {
    if (window.crypto?.randomUUID) return `local:${window.crypto.randomUUID()}`;
    const bytes = new Uint32Array(4);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else bytes[0] = Date.now();
    return `local:${Array.from(bytes).map((item) => item.toString(16)).join("")}`;
  }

  function addLocalExtra(classKey, displayName, existingMembers = []) {
    const key = cleanText(classKey);
    const name = cleanText(displayName, 160);
    if (!key || !name) throw new Error("Use a valid student name.");
    const extras = normalizeExtras(readJson(LOCAL_EXTRAS_KEY));
    const presentNames = new Set(
      [...(Array.isArray(existingMembers) ? existingMembers : []), ...(extras.classes[key] || [])]
        .map((entry) => cleanText(entry?.displayName, 160).toLowerCase())
        .filter(Boolean)
    );
    if (presentNames.has(name.toLowerCase())) return { added: false, member: null };
    const member = { id: localId(), displayName: name, local: true, official: false };
    extras.classes[key] = [...(extras.classes[key] || []), member];
    if (!writeJson(LOCAL_EXTRAS_KEY, extras)) throw new Error("That student could not be saved on this device.");
    return { added: true, member };
  }

  function removeLocalExtra(classKey, memberId) {
    const key = cleanText(classKey);
    const id = cleanText(memberId);
    if (!key || !id) return false;
    const extras = normalizeExtras(readJson(LOCAL_EXTRAS_KEY));
    const entries = extras.classes[key] || [];
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length === entries.length) return false;
    if (remaining.length) extras.classes[key] = remaining;
    else delete extras.classes[key];
    if (!writeJson(LOCAL_EXTRAS_KEY, extras)) {
      throw new Error("That local student could not be removed from this device.");
    }
    return true;
  }

  function mergeMembers(officialMembers, localExtras) {
    const official = (Array.isArray(officialMembers) ? officialMembers : []).map(normalizeMember).filter(Boolean)
      .map((member) => ({ ...member, official: true, local: false }));
    const seenNames = new Set(official.map((member) => member.displayName.toLowerCase()));
    const conflicts = [];
    const extras = [];
    for (const raw of Array.isArray(localExtras) ? localExtras : []) {
      const member = normalizeMember({ ...raw, local: true, official: false });
      if (!member) continue;
      if (seenNames.has(member.displayName.toLowerCase())) {
        conflicts.push(member);
        continue;
      }
      seenNames.add(member.displayName.toLowerCase());
      extras.push(member);
    }
    return { members: [...official, ...extras], conflicts };
  }

  function normalizeLocalHidden(value) {
    if (!plainObject(value) || value.version !== CACHE_VERSION || !plainObject(value.classes)) {
      return { version: CACHE_VERSION, classes: {} };
    }
    const classes = {};
    for (const [classKey, keys] of Object.entries(value.classes)) {
      const normalizedClassKey = cleanText(classKey);
      if (!normalizedClassKey || !Array.isArray(keys)) continue;
      const seen = new Set();
      const normalizedKeys = keys.map((key) => cleanText(key)).filter((key) => key && !seen.has(key) && seen.add(key));
      if (normalizedKeys.length) classes[normalizedClassKey] = normalizedKeys;
    }
    return { version: CACHE_VERSION, classes };
  }

  function loadLocalHiddenStudentKeys(classKey) {
    const key = cleanText(classKey);
    if (!key) return [];
    return normalizeLocalHidden(readJson(LOCAL_HIDDEN_KEY)).classes[key] || [];
  }

  function saveLocalHiddenStudentKeys(classKey, keys) {
    const key = cleanText(classKey);
    if (!key || !Array.isArray(keys)) throw new Error("Local attendance settings are invalid.");
    const state = normalizeLocalHidden(readJson(LOCAL_HIDDEN_KEY));
    const seen = new Set();
    const normalized = keys.map((item) => cleanText(item)).filter((item) => item && !seen.has(item) && seen.add(item));
    if (normalized.length) state.classes[key] = normalized;
    else delete state.classes[key];
    if (!writeJson(LOCAL_HIDDEN_KEY, state)) throw new Error("Local attendance could not be saved on this device.");
    return normalized;
  }

  window.StudentShuffleRosterHub = Object.freeze({
    configKey: CONFIG_KEY,
    sessionKey: SESSION_KEY,
    pendingInviteKey: PENDING_INVITE_KEY,
    cacheKey: CACHE_KEY,
    localExtrasKey: LOCAL_EXTRAS_KEY,
    localHiddenKey: LOCAL_HIDDEN_KEY,
    loadConfig,
    saveConfig,
    loadSession,
    clearSession,
    signIn,
    hasPendingInvite,
    acceptInviteRedirect,
    setPassword,
    loadCachedOfficialRoster,
    loadOfficialRoster,
    loadLocalExtras,
    addLocalExtra,
    removeLocalExtra,
    mergeMembers,
    loadLocalHiddenStudentKeys,
    saveLocalHiddenStudentKeys,
    parseOfficialRosterRows
  });
})();
