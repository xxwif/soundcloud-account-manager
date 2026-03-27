const API = typeof browser !== "undefined" ? browser : chrome;

const statusEl = document.getElementById("status");
const accountsListEl = document.getElementById("accountsList");
const saveCurrentBtn = document.getElementById("saveCurrentBtn");

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff7b7b" : "#9f9f9f";
}

async function sendMessage(message) {
  return API.runtime.sendMessage(message);
}

function createAccountItem(account) {
  const li = document.createElement("li");
  li.className = "account";

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = account.avatarUrl || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  avatar.alt = `${account.username} avatar`;

  const nameWrap = document.createElement("div");
  nameWrap.className = "name-wrap";

  const display = document.createElement("p");
  display.className = "display";
  display.textContent = account.displayName || account.username;

  const user = document.createElement("p");
  user.className = "user";
  user.textContent = `@${account.username}`;

  nameWrap.append(display, user);

  const switchBtn = document.createElement("button");
  switchBtn.className = "switch-btn";
  switchBtn.type = "button";
  switchBtn.textContent = "switch";
  switchBtn.addEventListener("click", async () => {
    setStatus(`switching to @${account.username}...`);
    const result = await sendMessage({ type: "SWITCH_ACCOUNT", accountId: account.id });
    if (!result?.ok) {
      setStatus(result?.error || "failed to switch account.", true);
      return;
    }
    setStatus("switched. reloading...");
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.type = "button";
  removeBtn.textContent = "remove";
  removeBtn.addEventListener("click", async () => {
    const result = await sendMessage({ type: "REMOVE_ACCOUNT", accountId: account.id });
    if (!result?.ok) {
      setStatus("failed to remove account.", true);
      return;
    }
    await render();
    setStatus(`removed @${account.username}`);
  });

  li.append(avatar, nameWrap, switchBtn, removeBtn);
  return li;
}

async function render() {
  const result = await sendMessage({ type: "GET_ACCOUNTS" });
  const accounts = result?.accounts || [];

  accountsListEl.innerHTML = "";
  if (!accounts.length) {
    const empty = document.createElement("li");
    empty.className = "account";
    empty.textContent = "no saved accounts yet. open soundcloud and click save current.";
    accountsListEl.append(empty);
    return;
  }

  accounts
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .forEach((account) => {
      accountsListEl.append(createAccountItem(account));
    });
}

saveCurrentBtn.addEventListener("click", async () => {
  setStatus("saving...");
  const result = await sendMessage({ type: "SAVE_CURRENT_ACCOUNT" });
  if (!result?.ok) {
    setStatus(result?.error || "failed to save account.", true);
    return;
  }
  await render();
  setStatus(`saved @${result.account.username}`);
});

render().catch(() => setStatus("could not load accounts.", true));
