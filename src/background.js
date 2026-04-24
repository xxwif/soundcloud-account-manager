const API = typeof browser !== "undefined" ? browser : chrome;
const STORAGE_KEY = "scam_accounts_v1";
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

async function readSoundCloudCookies() {
  const cookies = await API.cookies.getAll({ domain: "soundcloud.com" });
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    firstPartyDomain: cookie.firstPartyDomain
  }));
}

async function clearSoundCloudCookies() {
  const cookies = await API.cookies.getAll({ domain: "soundcloud.com" });
  await Promise.allSettled(
    cookies.map((cookie) => {
      const host = cookie.domain.startsWith(".")
        ? cookie.domain.slice(1)
        : cookie.domain;
      const protocol = cookie.secure ? "https://" : "http://";
      return API.cookies.remove({
        url: `${protocol}${host}${cookie.path}`,
        name: cookie.name,
        storeId: cookie.storeId
      });
    })
  );
}

function normalizeSameSite(sameSite, secure) {
  if (!sameSite) return null;
  const normalized = String(sameSite).toLowerCase();
  if (normalized.includes("strict")) return "strict";
  if (normalized.includes("lax")) return "lax";
  if (normalized.includes("none") || normalized.includes("no_restriction")) {
    return secure ? "no_restriction" : null;
  }
  return null;
}

async function applySoundCloudCookies(cookies) {
  await Promise.allSettled(
    cookies.map((cookie) => {
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

      if (cookie.domain) {
        details.domain = cookie.domain;
      }

      if (typeof cookie.expirationDate === "number") {
        details.expirationDate = cookie.expirationDate;
      }

      if (cookie.firstPartyDomain) {
        details.firstPartyDomain = cookie.firstPartyDomain;
      }

      const sameSite = normalizeSameSite(cookie.sameSite, cookie.secure);
      if (sameSite) details.sameSite = sameSite;

      return API.cookies.set(details);
    })
  );
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
  const account = {
    id: profile.id || `${profile.username}-${now}`,
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

const pendingLogins = new Map();

API.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!pendingLogins.has(tabId)) return;

  const url = tab.url || "";
  if (!url.includes("soundcloud.com")) return;
  if (
    url.includes("/signin") ||
    url.includes("/login") ||
    url.includes("/forgot") ||
    url.includes("/password")
  ) return;

  pendingLogins.delete(tabId);

  (async () => {
    const delays = [2000, 3000, 5000];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      const profile = await sendMessageToTab(tabId, { type: "EXTRACT_SC_PROFILE" });
      if (profile?.ok && profile.username) {
        const newCookies = await readSoundCloudCookies();
        await createOrUpdateAccount({ ...profile, cookies: newCookies });
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

      const originalCookies = await readSoundCloudCookies();
      const currentProfile = await sendMessageToTab(callerTab.id, {
        type: "EXTRACT_SC_PROFILE"
      });
      if (currentProfile?.ok && currentProfile.username) {
        await createOrUpdateAccount({ ...currentProfile, cookies: originalCookies });
      }

      await clearSoundCloudCookies();
      await API.tabs.update(callerTab.id, { url: "https://soundcloud.com/signin" });

      pendingLogins.set(callerTab.id, {});
      setTimeout(() => pendingLogins.delete(callerTab.id), 10 * 60 * 1000);

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

      const cookies = await readSoundCloudCookies();
      const account = await createOrUpdateAccount({ ...profile, cookies });
      sendResponse({ ok: true, account });
      return;
    }

    if (message?.type === "REMOVE_ACCOUNT") {
      const accounts = await getAccounts();
      const filtered = accounts.filter((a) => a.id !== message.accountId);
      await setAccounts(filtered);
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

      await clearSoundCloudCookies();
      await applySoundCloudCookies(account.cookies || []);
      await sendMessageToTab(tab.id, {
        type: "APPLY_LOCAL_STORAGE",
        localStorageSnapshot: account.localStorageSnapshot || {}
      });
      sendResponse({ ok: true });
      API.tabs.reload(tab.id).catch(() => {});
      return;
    }

    sendResponse({ ok: false, error: "unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "unexpected error." });
  });

  return true;
});
