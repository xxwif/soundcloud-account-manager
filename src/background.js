const API = typeof browser !== "undefined" ? browser : chrome;
// Firefox exposes runtime.getBrowserInfo; Chrome doesn't.
const IS_FIREFOX = typeof API.runtime?.getBrowserInfo === "function";
const STORAGE_KEY = "scam_accounts_v1";
const PENDING_VERIFY_KEY = "scam_pending_verify";
const SC_URL = "https://soundcloud.com";

if (API.action) {
  API.action.disable();
} else if (API.browserAction) {
  API.browserAction.disable();
}

async function getAccounts() {
  const data = await API.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setAccounts(accounts) {
  await API.storage.local.set({ [STORAGE_KEY]: accounts });
}

// Cookies that belong to the browser, not to a SoundCloud account. They are
// never cleared or restored when switching:
//  - datadome: SoundCloud's bot protection. An old copy from another session
//    can trigger captchas or block sign-in.
//  - consent/theme: otherwise the cookie banner reappears on every switch.
const DEVICE_COOKIE_NAMES = new Set([
  "datadome",
  "OptanonConsent",
  "OptanonAlertBoxClosed",
  "cookie_consent",
  "sc_theme"
]);

function isDeviceCookie(cookie) {
  return DEVICE_COOKIE_NAMES.has(cookie.name);
}

// Firefox only: the cookie store a tab uses. Tabs in Multi-Account Containers
// (and private windows) have their own cookie jar, so switching accounts must
// read and write that jar, not the default one. Chrome tabs have no
// cookieStoreId, so this is undefined there and the default store is used.
function storeIdForTab(tab) {
  return tab?.cookieStoreId || undefined;
}

async function getAllSoundCloudCookies(storeId) {
  const query = { domain: "soundcloud.com" };
  if (storeId) query.storeId = storeId;
  try {
    return await API.cookies.getAll(query);
  } catch (error) {
    // Firefox with first-party isolation turned on requires firstPartyDomain;
    // null means "any". Chrome never takes this path.
    return API.cookies.getAll({ ...query, firstPartyDomain: null });
  }
}

async function readSoundCloudCookies(storeId) {
  const cookies = (await getAllSoundCloudCookies(storeId))
    .filter((cookie) => !isDeviceCookie(cookie));
  return cookies.map((cookie) => {
    const saved = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate
    };
    // Firefox only; Chrome rejects this field, so only keep it when present.
    if (typeof cookie.firstPartyDomain === "string") {
      saved.firstPartyDomain = cookie.firstPartyDomain;
    }
    return saved;
  });
}

async function clearSoundCloudCookies(storeId) {
  const cookies = (await getAllSoundCloudCookies(storeId))
    .filter((cookie) => !isDeviceCookie(cookie));
  await Promise.allSettled(
    cookies.map((cookie) => {
      const host = cookie.domain.startsWith(".")
        ? cookie.domain.slice(1)
        : cookie.domain;
      const protocol = cookie.secure ? "https://" : "http://";
      const details = {
        url: `${protocol}${host}${cookie.path}`,
        name: cookie.name,
        storeId: cookie.storeId
      };
      if (typeof cookie.firstPartyDomain === "string") {
        details.firstPartyDomain = cookie.firstPartyDomain;
      }
      return API.cookies.remove(details);
    })
  );
}

function normalizeSameSite(sameSite) {
  const normalized = String(sameSite || "").toLowerCase();
  // Check no_restriction first: the string "no_restriction" contains "strict".
  if (normalized === "no_restriction" || normalized === "none") return "no_restriction";
  if (normalized === "strict") return "strict";
  if (normalized === "lax") return "lax";
  return "unspecified";
}

// Chrome reports host-only cookies with a bare domain ("soundcloud.com") and
// domain cookies with a leading dot (".soundcloud.com"). Older saved accounts
// don't have the hostOnly flag, so fall back to that rule.
function isHostOnly(cookie) {
  if (typeof cookie.hostOnly === "boolean") return cookie.hostOnly;
  return !String(cookie.domain || "").startsWith(".");
}

async function applySoundCloudCookies(cookies, storeId) {
  const nowSeconds = Date.now() / 1000;
  const seen = new Set();

  const toApply = cookies.filter((cookie) => {
    // Accounts saved by older versions still contain these; skip them.
    if (isDeviceCookie(cookie)) return false;
    // Expired cookies can't be restored; setting them only deletes things.
    if (typeof cookie.expirationDate === "number" && cookie.expirationDate <= nowSeconds) {
      return false;
    }
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await Promise.allSettled(
    toApply.map((cookie) => {
      const host = cookie.domain.startsWith(".")
        ? cookie.domain.slice(1)
        : cookie.domain;
      const url = `${cookie.secure ? "https://" : "http://"}${host}${cookie.path}`;
      const details = {
        url,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly
      };

      // IMPORTANT: passing `domain` turns a host-only cookie into a domain
      // cookie. SoundCloud then can't overwrite or delete it on sign-in or
      // sign-out, so a stale session cookie sits next to the real one and
      // causes the login/logout loop. Only set `domain` for real domain cookies.
      if (!isHostOnly(cookie)) {
        details.domain = cookie.domain;
      }

      if (typeof cookie.expirationDate === "number") {
        details.expirationDate = cookie.expirationDate;
      }

      if (storeId) {
        details.storeId = storeId;
      }

      // Firefox only (first-party isolation). Accounts saved in Chrome or by
      // older versions don't have it, and Chrome rejects the field.
      if (typeof cookie.firstPartyDomain === "string" && IS_FIREFOX) {
        details.firstPartyDomain = cookie.firstPartyDomain;
      }

      // Firefox doesn't accept "unspecified" (it treats a missing SameSite as
      // None), so leaving the field out is right in both browsers.
      const sameSite = normalizeSameSite(cookie.sameSite);
      // SameSite=None requires Secure; otherwise the set call is rejected.
      if (sameSite !== "unspecified" && !(sameSite === "no_restriction" && !cookie.secure)) {
        details.sameSite = sameSite;
      }

      return API.cookies.set(details);
    })
  );
}

// --- Switch verification (from 0.1.6) ---------------------------------------
// After a switch, the reloaded page checks it's signed in as the account we
// switched to. If it isn't (e.g. that account's saved session expired), the
// previous session is put back so you're never left signed out.
async function getPendingVerify() {
  const data = await API.storage.local.get(PENDING_VERIFY_KEY);
  return data[PENDING_VERIFY_KEY] || null;
}

async function setPendingVerify(payload) {
  await API.storage.local.set({ [PENDING_VERIFY_KEY]: payload });
}

async function rollbackSwitch(tab, fallback) {
  const storeId = fallback?.storeId || storeIdForTab(tab);
  await clearSoundCloudCookies(storeId);
  await applySoundCloudCookies(fallback?.cookies || [], storeId);
  await setActiveAccountId(fallback?.activeAccountId || null);
  if (tab?.id) {
    await sendMessageToTab(tab.id, {
      type: "APPLY_LOCAL_STORAGE",
      localStorageSnapshot: fallback?.localStorageSnapshot || {}
    });
    await API.tabs.reload(tab.id).catch(() => {});
  }
}

async function withActiveSoundCloudTab() {
  const tabs = await API.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://soundcloud.com/*", "https://*.soundcloud.com/*"]
  });
  return tabs[0] || null;
}

async function sendMessageToTab(tabId, message) {
  try {
    return await API.tabs.sendMessage(tabId, message);
  } catch (error) {
    return null;
  }
}

async function createOrUpdateAccount(profile) {
  const accounts = await getAccounts();
  const now = Date.now();
  const existingIndex = accounts.findIndex((a) => a.username === profile.username);
  const existingId = existingIndex >= 0 ? accounts[existingIndex].id : null;
  const account = {
    // Keep the existing id when re-saving, otherwise menu items and the
    // active-account marker point at an id that no longer exists.
    id: existingId || profile.id || `${profile.username}-${now}`,
    username: profile.username,
    displayName: profile.displayName || profile.username,
    profileUrl: profile.profileUrl || `${SC_URL}/${profile.username}`,
    avatarUrl: profile.avatarUrl || "",
    cookies: profile.cookies || [],
    localStorageSnapshot: profile.localStorageSnapshot || {},
    updatedAt: now
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], ...account };
  } else {
    accounts.push(account);
  }
  await setAccounts(accounts);
  return account;
}

// The MV3 service worker is shut down after ~30s idle, so anything kept in a
// plain variable (like the old pendingLogins Map) is lost. Use storage instead.
const PENDING_KEY = "scam_pending_logins";
const ACTIVE_KEY = "scam_active_account_id";
const sessionStore = API.storage.session || API.storage.local;

async function getPendingLogins() {
  const data = await sessionStore.get(PENDING_KEY);
  const pending = data[PENDING_KEY] || {};
  const now = Date.now();
  for (const [tabId, expiresAt] of Object.entries(pending)) {
    if (expiresAt <= now) delete pending[tabId];
  }
  return pending;
}

async function setPendingLogin(tabId, active) {
  const pending = await getPendingLogins();
  if (active) {
    pending[tabId] = Date.now() + 10 * 60 * 1000;
  } else {
    delete pending[tabId];
  }
  await sessionStore.set({ [PENDING_KEY]: pending });
}

async function getActiveAccountId() {
  const data = await API.storage.local.get(ACTIVE_KEY);
  return data[ACTIVE_KEY] || null;
}

async function setActiveAccountId(id) {
  await API.storage.local.set({ [ACTIVE_KEY]: id || null });
}

// SoundCloud rotates its session cookies while you use it. Before switching
// away, store the fresh cookies for the account that is signed in now, so its
// saved copy doesn't go stale. Only do it when the page's username matches the
// account we last switched to, so cookies never land on the wrong account.
async function refreshActiveAccount(tab) {
  const tabId = tab?.id;
  const activeId = await getActiveAccountId();
  if (!activeId || !tabId) return;
  const accounts = await getAccounts();
  const active = accounts.find((a) => a.id === activeId);
  if (!active) return;
  const profile = await sendMessageToTab(tabId, { type: "EXTRACT_SC_PROFILE" });
  if (!profile?.ok || profile.username !== active.username) return;
  const cookies = await readSoundCloudCookies(storeIdForTab(tab));
  await createOrUpdateAccount({ ...profile, id: active.id, cookies });
}

API.tabs.onRemoved.addListener((tabId) => {
  setPendingLogin(tabId, false).catch(() => {});
});

API.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  const url = tab.url || "";
  if (!url.includes("soundcloud.com")) return;
  if (
    url.includes("/signin") ||
    url.includes("/login") ||
    url.includes("/forgot") ||
    url.includes("/password")
  ) return;

  (async () => {
    const pending = await getPendingLogins();
    if (!pending[tabId]) return;
    await setPendingLogin(tabId, false);

    const delays = [2000, 3000, 5000];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      const profile = await sendMessageToTab(tabId, { type: "EXTRACT_SC_PROFILE" });
      if (profile?.ok && profile.username) {
        const newCookies = await readSoundCloudCookies(storeIdForTab(tab));
        const saved = await createOrUpdateAccount({ ...profile, cookies: newCookies });
        await setActiveAccountId(saved.id);
        return;
      }
    }
  })().catch(() => {});
});

API.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_ACCOUNTS") {
      const accounts = await getAccounts();
      sendResponse({ ok: true, accounts });
      return;
    }

    if (message?.type === "OPEN_LOGIN_TAB") {
      const callerTab = sender?.tab || (await withActiveSoundCloudTab());
      if (!callerTab?.id) {
        sendResponse({ ok: false, error: "no soundcloud tab found." });
        return;
      }

      const storeId = storeIdForTab(callerTab);
      const originalCookies = await readSoundCloudCookies(storeId);
      const currentProfile = await sendMessageToTab(callerTab.id, {
        type: "EXTRACT_SC_PROFILE"
      });
      if (currentProfile?.ok && currentProfile.username) {
        await createOrUpdateAccount({ ...currentProfile, cookies: originalCookies });
      }

      await clearSoundCloudCookies(storeId);
      await setActiveAccountId(null);
      await setPendingLogin(callerTab.id, true);
      await API.tabs.update(callerTab.id, { url: "https://soundcloud.com/signin" });

      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SAVE_CURRENT_ACCOUNT") {
      const tab = sender?.tab || (await withActiveSoundCloudTab());
      if (!tab?.id) {
        sendResponse({ ok: false, error: "open a soundcloud tab first." });
        return;
      }

      const profile = await sendMessageToTab(tab.id, { type: "EXTRACT_SC_PROFILE" });
      if (!profile?.ok || !profile.username) {
        sendResponse({ ok: false, error: "could not read profile. make sure you're logged in." });
        return;
      }

      const cookies = await readSoundCloudCookies(storeIdForTab(tab));
      const account = await createOrUpdateAccount({ ...profile, cookies });
      await setActiveAccountId(account.id);
      sendResponse({ ok: true, account });
      return;
    }

    if (message?.type === "UPDATE_ACCOUNT_AVATAR") {
      // Only updates the picture of an account that's already saved; never
      // touches cookies or creates accounts.
      const url = String(message.avatarUrl || "");
      if (!/^https:\/\/[^/]*sndcdn\.com\//.test(url)) {
        sendResponse({ ok: false, error: "invalid avatar url." });
        return;
      }
      const accounts = await getAccounts();
      const account = accounts.find((a) => a.username === message.username);
      if (account && account.avatarUrl !== url) {
        account.avatarUrl = url;
        await setAccounts(accounts);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "REMOVE_ACCOUNT") {
      const accounts = await getAccounts();
      const filtered = accounts.filter((a) => a.id !== message.accountId);
      await setAccounts(filtered);
      if ((await getActiveAccountId()) === message.accountId) {
        await setActiveAccountId(null);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SWITCH_ACCOUNT") {
      const accounts = await getAccounts();
      const account = accounts.find((a) => a.id === message.accountId);
      const tab = sender?.tab || (await withActiveSoundCloudTab());

      if (!account) {
        sendResponse({ ok: false, error: "account not found." });
        return;
      }
      if (!tab?.id) {
        sendResponse({ ok: false, error: "open a soundcloud tab first." });
        return;
      }

      const previousActiveId = await getActiveAccountId();
      if (previousActiveId !== account.id) {
        await refreshActiveAccount(tab);
      }

      const storeId = storeIdForTab(tab);

      // Remember the current session so it can be restored if the switch fails.
      const fallbackCookies = await readSoundCloudCookies(storeId);
      const currentProfile = await sendMessageToTab(tab.id, { type: "EXTRACT_SC_PROFILE" });
      await setPendingVerify({
        tabId: tab.id,
        expectedUsername: account.username,
        fallback: {
          cookies: fallbackCookies,
          localStorageSnapshot: currentProfile?.localStorageSnapshot || {},
          activeAccountId: previousActiveId,
          storeId
        },
        timestamp: Date.now()
      });

      await clearSoundCloudCookies(storeId);
      await applySoundCloudCookies(account.cookies || [], storeId);
      await setActiveAccountId(account.id);
      await sendMessageToTab(tab.id, {
        type: "APPLY_LOCAL_STORAGE",
        localStorageSnapshot: account.localStorageSnapshot || {}
      });
      sendResponse({ ok: true });
      API.tabs.reload(tab.id).catch(() => {});
      return;
    }

    if (message?.type === "GET_VERIFY_PENDING") {
      const verify = await getPendingVerify();
      if (!verify || verify.tabId !== sender?.tab?.id) {
        sendResponse({ pending: false });
        return;
      }
      if (Date.now() - verify.timestamp > 30 * 1000) {
        await API.storage.local.remove(PENDING_VERIFY_KEY);
        sendResponse({ pending: false });
        return;
      }
      sendResponse({ pending: true, expectedUsername: verify.expectedUsername });
      return;
    }

    if (message?.type === "VERIFY_RESULT") {
      const verify = await getPendingVerify();
      if (!verify || verify.tabId !== sender?.tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      await API.storage.local.remove(PENDING_VERIFY_KEY);
      if (message.success) {
        sendResponse({ ok: true });
        return;
      }
      await rollbackSwitch(sender.tab, verify.fallback);
      sendResponse({ ok: true, rolledBack: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "unexpected error." });
  });

  return true;
});
