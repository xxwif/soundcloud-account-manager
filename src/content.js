const SC_RESERVED_PATHS = new Set([
  "discover", "stream", "upload", "you", "feed", "charts", "search",
  "signin", "login", "logout", "signup", "forgot", "password",
  "settings", "messages", "notifications", "stations",
  "collection", "library", "history", "likes", "playlists",
  "popular", "trending", "people", "pages", "home",
  "legal", "privacy", "pro", "premium",
  "soundcloud-scenes", "hear-the-next", "blog",
  "artists", "for", "company", "creators", "terms-of-use",
  "mobile", "jobs", "imprint", "connect",
]);

function getUsernameFromProfileUrl(profileUrl) {
  if (!profileUrl) return "";
  try {
    const url = new URL(profileUrl, location.origin);
    const segment = url.pathname.split("/").filter(Boolean)[0];
    if (!segment || SC_RESERVED_PATHS.has(segment.toLowerCase())) return "";
    return segment;
  } catch {
    return "";
  }
}

// These keys belong to the browser, not to an account. Restoring an old copy
// of SoundCloud's DataDome bot-protection session can trigger captchas/blocks.
function isDeviceLocalStorageKey(key) {
  return /datadome/i.test(key) || key === "V2::local::theme";
}

function readLocalStorageSnapshot() {
  const snapshot = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || isDeviceLocalStorageKey(key)) continue;
    snapshot[key] = localStorage.getItem(key);
  }
  return snapshot;
}

function applyLocalStorageSnapshot(snapshot) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
    keys.forEach((key) => {
      if (key && !isDeviceLocalStorageKey(key)) localStorage.removeItem(key);
    });
  } catch {
    return;
  }
  Object.entries(snapshot).forEach(([key, value]) => {
    if (isDeviceLocalStorageKey(key)) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore quota errors so one oversized key doesn't break the switch.
    }
  });
}

// New SoundCloud header (2025/2026):
//   <div class="header__userNav">
//     <a href="/<username>" class="header__userNavUsernameButton" data-test-id="user-nav-btn">
//       <div class="header__userNavAvatar">
//         <span style="background-image: url(...)" aria-label="<name>'s avatar">
// Only read from the header. The old broad selectors ([class*="user"] a, header a)
// could pick up another artist's link from the feed and save your cookies
// under their name.
function getUserNavButton() {
  return document.querySelector(
    'header [data-test-id="user-nav-btn"], header a.header__userNavUsernameButton'
  );
}

function getAvatarUrl(navButton) {
  const scope = navButton || document.querySelector("header .header__userNav");
  if (!scope) return "";
  const bgEl = scope.querySelector('[style*="background-image"]');
  if (bgEl) {
    const match = /url\(["']?([^"')]+)["']?\)/.exec(bgEl.style.backgroundImage || "");
    if (match) return match[1];
  }
  const img = scope.querySelector("img");
  return img?.getAttribute("src") || "";
}

function getDisplayName(navButton) {
  const label = navButton
    ?.querySelector("[aria-label]")
    ?.getAttribute("aria-label") || "";
  // "swif’s avatar" -> "swif" (English UI; other languages fall back to username)
  const match = /^(.*?)[’']s avatar$/i.exec(label.trim());
  return match ? match[1].trim() : "";
}

function extractProfile() {
  const navButton = getUserNavButton();
  let profileUrl = navButton?.href || "";

  if (!profileUrl) {
    // Fallback: the "Profile" link inside the open profile menu.
    const profileLink = Array.from(
      document.querySelectorAll(".profileMenu a, .headerMenu a")
    ).find((a) => norm(a.textContent) === "profile");
    profileUrl = profileLink?.href || "";
  }

  const username = getUsernameFromProfileUrl(profileUrl);
  if (!username) return { ok: false };

  return {
    ok: true,
    username,
    displayName: getDisplayName(navButton) || username,
    profileUrl,
    avatarUrl: getAvatarUrl(navButton),
    localStorageSnapshot: readLocalStorageSnapshot()
  };
}

const API = typeof browser !== "undefined" ? browser : chrome;
const INJECTED_ATTR = "data-scam-injected";

function norm(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

function hasMenuLinks() {
  let profile = false;
  let likes = false;
  for (const el of document.querySelectorAll("a, button")) {
    const t = norm(el.textContent);
    if (t === "profile") profile = true;
    else if (t === "likes") likes = true;
    if (profile && likes) return true;
  }
  return false;
}

// New UI: the profile dropdown is
//   <div class="dropdownMenu"><div class="headerMenu profileMenu">
//     <ul class="headerMenu__list"><li><a class="headerMenu__link">…Profile</a></li>…
function findProfileMenuList() {
  const list = document.querySelector(".profileMenu ul.headerMenu__list");
  return list && isVisible(list) ? list : null;
}

function findAllMenuCandidates() {
  const direct = findProfileMenuList();
  if (direct) {
    if (direct.hasAttribute(INJECTED_ATTR) && direct.querySelector("[data-scam-item]")) return [];
    return [direct];
  }
  // SoundCloud's DOM changes constantly (player progress, infinite scroll).
  // Skip the expensive scan unless the account menu is actually open.
  if (!hasMenuLinks()) return [];
  return Array.from(document.querySelectorAll("ul, nav, div, section")).filter((el) => {
    if (el.hasAttribute(INJECTED_ATTR) && el.querySelector("[data-scam-item]")) return false;
    const links = Array.from(el.querySelectorAll("a, button"));
    if (links.length > 15) return false;
    const labels = links.map((l) => norm(l.textContent));
    const hasProfile = labels.some((t) => t === "profile");
    const hasLikes = labels.some((t) => t === "likes");
    const hasYouLink = links.some((l) => (l.getAttribute("href") || "").startsWith("/you/"));
    return hasProfile && hasLikes && hasYouLink;
  });
}

function claimMenuContainer(candidates) {
  if (!candidates.length) return null;
  candidates.forEach((el) => el.setAttribute(INJECTED_ATTR, "1"));
  const visible = candidates.filter(isVisible);
  const pool = visible.length ? visible : candidates;
  return pool.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  })[0];
}

function findOpaqueAncestor(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return node;
    node = node.parentElement;
  }
  return el;
}

// Uses setTimeout, not requestAnimationFrame: rAF is paused in background
// tabs, which left injectionPending stuck and the menu never got its items.
function waitForMenuReady(container) {
  return new Promise((resolve) => {
    const deadline = Date.now() + 600;
    const next = () => setTimeout(check, 16);
    function check() {
      const bgEl = findOpaqueAncestor(container);
      const style = window.getComputedStyle(bgEl);
      const bg = style.backgroundColor;
      const opacity = parseFloat(style.opacity ?? "1");
      const hasBackground = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      if ((hasBackground && opacity >= 0.99) || Date.now() >= deadline) {
        resolve();
        return;
      }
      next();
    }
    next();
  });
}

function findItemsParent(container) {
  const anchor = Array.from(container.querySelectorAll("a, button")).find((el) => {
    const t = norm(el.textContent);
    return t === "profile" || t === "likes";
  });
  if (!anchor) return container;
  const parent = anchor.parentElement;
  if (!parent) return container;
  // Links are wrapped in <li>; add our items next to those <li>s.
  if (parent.tagName === "LI" && parent.parentElement) return parent.parentElement;
  const menuSiblings = Array.from(parent.children).filter((c) => c.matches("a, button, li"));
  return menuSiblings.length >= 3 ? parent : container;
}

function getPrototype(container) {
  const profileLink = Array.from(container.querySelectorAll("a.headerMenu__link"))
    .find((el) => norm(el.textContent) === "profile" && !el.hasAttribute("data-scam-item"));
  if (profileLink) return profileLink;
  const items = Array.from(container.querySelectorAll("a, button"));
  const visible = items.filter(isVisible);
  const pool = visible.length ? visible : items;
  return pool.find((el) => norm(el.textContent).length > 2 && !el.hasAttribute("data-scam-item")) || null;
}

// Wrap our cloned link in an <li> when SoundCloud's links are in <li>s, so the
// list stays valid and gets the same spacing/hover styles.
function wrapLikePrototype(prototype, item) {
  const parent = prototype.parentElement;
  if (!parent || parent.tagName !== "LI") return item;
  const li = parent.cloneNode(false);
  li.setAttribute("data-scam-item", "true");
  li.appendChild(item);
  return li;
}

// 16x16 icons drawn in the same style as SoundCloud's profile menu icons
// (filled, currentColor, so they follow light/dark theme).
const ICON_PATHS = {
  // Same person glyph SoundCloud uses for "Profile".
  profile:
    "M8 7.5a3 3 0 100-6 3 3 0 000 6zM2.001 14.248C2.036 10.005 2.984 8.5 8 8.5s5.965 1.487 5.999 5.748a.25.25 0 01-.249.252H2.25a.25.25 0 01-.249-.252z",
  plus:
    "M7.25 2.5h1.5v4.75h4.75v1.5H8.75v4.75h-1.5V8.75H2.5v-1.5h4.75z"
};

function createIcon(kind, className) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className || "profileMenu__icon");
  const g = document.createElementNS(NS, "g");
  g.setAttribute("fill", "currentColor");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICON_PATHS[kind]);
  g.appendChild(path);
  svg.appendChild(g);
  return svg;
}

// Replace the icon copied from SoundCloud's row with ours, keeping its
// wrapper so spacing matches the other menu items.
function setIcon(item, kind) {
  const existing = item.querySelector("svg");
  const icon = createIcon(kind, existing?.getAttribute("class"));
  if (existing) {
    existing.replaceWith(icon);
  } else {
    const box = document.createElement("div");
    box.style.cssText = "width:24px;flex:0 0 24px;display:flex;align-items:center;";
    box.appendChild(icon);
    icon.style.cssText = "width:16px;height:16px;";
    item.insertBefore(box, item.firstChild);
  }
}

// Show the account's profile picture as a small circle in place of the icon.
// Falls back to the person icon if there's no picture or it fails to load.
function setAvatar(item, avatarUrl) {
  if (!avatarUrl) {
    setIcon(item, "profile");
    return;
  }
  const existing = item.querySelector("svg");
  const img = document.createElement("img");
  img.src = avatarUrl;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.referrerPolicy = "no-referrer";
  // SoundCloud's 16px icons get an 8px right margin from their CSS class, so
  // the text starts 24px in. The <img> doesn't get that class, so give it the
  // same 24px column (18px picture + 6px gap) or it sits on top of the text.
  img.style.cssText =
    "width:18px;height:18px;min-width:18px;border-radius:50%;object-fit:cover;display:block;margin:0 6px 0 -1px;";
  img.addEventListener("error", () => {
    const icon = createIcon("profile", existing?.getAttribute("class"));
    img.replaceWith(icon);
  }, { once: true });

  if (existing) {
    const box = existing.parentElement;
    existing.replaceWith(img);
    if (box && box !== item) {
      box.style.width = "24px";
      box.style.flex = "0 0 24px";
      box.style.display = "flex";
      box.style.alignItems = "center";
    }
  } else {
    const box = document.createElement("div");
    box.style.cssText = "width:24px;flex:0 0 24px;display:flex;align-items:center;";
    box.appendChild(img);
    item.insertBefore(box, item.firstChild);
  }
}

function buildMenuItem(prototype, label, onClick, iconKind = "plus") {
  const item = prototype.cloneNode(true);
  item.setAttribute("data-scam-item", "true");
  item.removeAttribute("href");
  item.removeAttribute("target");
  item.style.cursor = "pointer";

  const textNodes = [];
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  const labelNode = textNodes
    .filter((n) => n.nodeValue.trim().length > 0)
    .sort((a, b) => b.nodeValue.trim().length - a.nodeValue.trim().length)[0];

  textNodes.forEach((n) => { n.nodeValue = ""; });

  if (labelNode) {
    labelNode.nodeValue = label;
  } else {
    item.appendChild(document.createTextNode(label));
  }

  item.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });

  setIcon(item, iconKind);
  return wrapLikePrototype(prototype, item);
}

async function addAccountFromMenu() {
  await API.runtime.sendMessage({ type: "OPEN_LOGIN_TAB" });
}

async function switchAccountFromMenu(accountId) {
  const result = await API.runtime.sendMessage({ type: "SWITCH_ACCOUNT", accountId });
  if (!result?.ok) {
    window.alert(result?.error || "failed to switch account.");
  }
}

async function removeAccountFromMenu(accountId) {
  await API.runtime.sendMessage({ type: "REMOVE_ACCOUNT", accountId });
}

function buildAccountItem(prototype, account) {
  const item = prototype.cloneNode(true);
  item.setAttribute("data-scam-item", "true");
  item.removeAttribute("href");
  item.removeAttribute("target");
  item.style.cursor = "pointer";
  item.style.position = "relative";

  const textNodes = [];
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const labelNode = textNodes
    .filter((n) => n.nodeValue.trim().length > 0)
    .sort((a, b) => b.nodeValue.trim().length - a.nodeValue.trim().length)[0];

  textNodes.forEach((n) => { n.nodeValue = ""; });

  // The new menu is a narrow (≈157px) flex list. Put the name in its own span
  // so long usernames are cut off with "…" instead of wrapping under the ×.
  const labelSpan = document.createElement("span");
  labelSpan.textContent = account.username;
  labelSpan.style.cssText =
    "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:18px;";
  if (labelNode?.parentNode) {
    labelNode.parentNode.insertBefore(labelSpan, labelNode);
  } else {
    item.appendChild(labelSpan);
  }

  item.title = account.displayName && account.displayName !== account.username
    ? `${account.displayName} (${account.username})`
    : account.username;
  item.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    switchAccountFromMenu(account.id).catch(() => {});
  });

  const removeBtn = document.createElement("span");
  removeBtn.textContent = "×";
  removeBtn.setAttribute("data-scam-item", "true");
  removeBtn.style.cssText = "position:absolute;right:10px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:16px;line-height:1;padding:0 4px;";
  removeBtn.addEventListener("mouseenter", () => { removeBtn.style.opacity = "1"; });
  removeBtn.addEventListener("mouseleave", () => { removeBtn.style.opacity = "0.5"; });
  removeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeAccountFromMenu(account.id).then(() => {
      wrapper.remove();
    }).catch(() => {});
  });

  item.appendChild(removeBtn);
  setAvatar(item, account.avatarUrl);
  const wrapper = wrapLikePrototype(prototype, item);
  return wrapper;
}

let injectionPending = false;

async function injectAccountMenu() {
  if (injectionPending) return;

  const candidates = findAllMenuCandidates();
  const container = claimMenuContainer(candidates);
  if (!container) return;

  const prototype = getPrototype(container);
  if (!prototype || !isVisible(prototype)) return;

  injectionPending = true;
  try {
    await waitForMenuReady(container);

    if (!document.contains(container)) return;

    container.querySelectorAll("[data-scam-item='true']").forEach((el) => el.remove());

    const itemsParent = findItemsParent(container);

    const accountsResult = await API.runtime.sendMessage({ type: "GET_ACCOUNTS" });
    const accounts = Array.isArray(accountsResult?.accounts) ? accountsResult.accounts : [];

    // If you changed your profile picture, use the one in the header now and
    // save it, so the menu always shows each account's current picture.
    const current = extractProfile();
    if (current.ok && current.avatarUrl) {
      const saved = accounts.find((a) => a.username === current.username);
      if (saved && saved.avatarUrl !== current.avatarUrl) {
        saved.avatarUrl = current.avatarUrl;
        API.runtime.sendMessage({
          type: "UPDATE_ACCOUNT_AVATAR",
          username: current.username,
          avatarUrl: current.avatarUrl
        }).catch(() => {});
      }
    }

    const addItem = buildMenuItem(prototype, "Add Account", () => {
      addAccountFromMenu().catch(() => {});
    });
    itemsParent.append(addItem);

    accounts
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 5)
      .forEach((account) => {
        itemsParent.append(buildAccountItem(prototype, account));
      });
  } finally {
    injectionPending = false;
  }
}

let scheduled = false;
function scheduleInject() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    injectAccountMenu().catch(() => {});
  });
}

const observer = new MutationObserver(scheduleInject);
observer.observe(document.documentElement, { subtree: true, childList: true });
scheduleInject();

// After a switch, confirm we're signed in as the expected account; if not,
// the background script restores the previous session.
async function checkPendingVerify() {
  const status = await API.runtime.sendMessage({ type: "GET_VERIFY_PENDING" });
  if (!status?.pending) return;

  let success = false;
  const delays = [2000, 3000, 5000];
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    const path = location.pathname || "";
    if (path.startsWith("/signin") || path.startsWith("/login")) break;
    const profile = extractProfile();
    if (profile?.ok && profile.username === status.expectedUsername) {
      success = true;
      break;
    }
  }

  await API.runtime.sendMessage({ type: "VERIFY_RESULT", success });
}

checkPendingVerify().catch(() => {});

API.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_SC_PROFILE") {
    sendResponse(extractProfile());
    return;
  }
  if (message?.type === "APPLY_LOCAL_STORAGE") {
    applyLocalStorageSnapshot(message.localStorageSnapshot || {});
    sendResponse({ ok: true });
  }
});
