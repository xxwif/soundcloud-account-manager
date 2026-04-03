function pickText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent?.trim()) {
      return el.textContent.trim();
    }
  }
  return "";
}

function pickHref(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.href) {
      return el.href;
    }
  }
  return "";
}

function pickImage(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const src = el.getAttribute("src") || el.getAttribute("data-src");
    if (src) return src;
  }
  return "";
}

const SC_RESERVED_PATHS = new Set([
  "discover", "stream", "upload", "you", "feed", "charts", "search",
  "signin", "login", "logout", "signup", "register", "forgot",
  "password", "settings", "messages", "notifications", "stations",
  "collection", "library", "history", "likes", "playlists", "sets",
  "following", "followers", "popular", "trending", "people",
  "pages", "legal", "imprint", "terms-of-use",
  "community-guidelines", "privacy", "cookies", "creator-guide",
  "for-artists", "go", "pro", "checkout", "premium",
  "soundcloud-scenes", "hear-the-next", "blog",
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

function readLocalStorageSnapshot() {
  const snapshot = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    snapshot[key] = localStorage.getItem(key);
  }
  return snapshot;
}

function applyLocalStorageSnapshot(snapshot) {
  localStorage.clear();
  Object.entries(snapshot).forEach(([key, value]) => {
    localStorage.setItem(key, value);
  });
}

function extractProfile() {
  const profileUrl = pickHref([
    'a[aria-label*="Profile"]',
    '[class*="user"] a[href^="/"]',
    "header a[href^='/']"
  ]);

  const displayName = pickText([
    '[aria-label*="Account"]',
    '[class*="user"] [class*="name"]',
    "header [class*='profile']"
  ]);

  const username = getUsernameFromProfileUrl(profileUrl);
  const avatarUrl = pickImage([
    'img[alt*="profile"]',
    'button[aria-label*="Account"] img',
    "header img"
  ]);

  if (!username) return { ok: false };

  return {
    ok: true,
    username,
    displayName: displayName || username,
    profileUrl,
    avatarUrl,
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

function findAllMenuCandidates() {
  return Array.from(document.querySelectorAll("ul, nav, div, section")).filter((el) => {
    if (el.hasAttribute(INJECTED_ATTR)) return false;
    const text = norm(el.textContent);
    const hasSignOut = text.includes("sign out") || text.includes("log out");
    const hasProfileIndicators = text.includes("profile") && text.includes("likes");
    return hasSignOut && hasProfileIndicators;
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

function waitForMenuReady(container) {
  return new Promise((resolve) => {
    const deadline = Date.now() + 600;
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
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
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
  const menuSiblings = Array.from(parent.children).filter((c) => c.matches("a, button, li"));
  return menuSiblings.length >= 3 ? parent : container;
}

function getPrototype(container) {
  const items = Array.from(container.querySelectorAll("a, button"));
  const visible = items.filter(isVisible);
  const pool = visible.length ? visible : items;
  return pool.find((el) => norm(el.textContent).length > 2 && !el.hasAttribute("data-scam-item")) || null;
}

function buildMenuItem(prototype, label, onClick) {
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

  return item;
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
  if (labelNode) {
    labelNode.nodeValue = account.username;
  } else {
    item.appendChild(document.createTextNode(account.username));
  }

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
      item.remove();
    }).catch(() => {});
  });

  item.appendChild(removeBtn);
  return item;
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
