const SESSION_KEY = "aurora_session";
const REVIEWS_KEY = "aurora_reviews";
const CART_KEY = "equity_cart";
const ORDERS_KEY = "equity_orders";

const MAX_QTY = 10;
const SHIPPING_FEE = 5.0;
const FREE_SHIPPING_MIN = 100.0;

// ---------- Session ----------

function getSession() {
  let session;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
  // A session from the old any-password demo login has no account behind it, so it no longer
  // counts as logged in.
  if (session && session.loggedIn && !findUser(session.username)) {
    clearSession();
    return null;
  }
  return session;
}

function setSession(username) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ loggedIn: true, username }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ---------- Accounts ----------

// Until there's a server, accounts live in this browser with the same fields as the users
// collection: { username, passwordHash, createdAt, lastLoginAt }. Passwords are kept only as a
// salted PBKDF2 hash. That keeps them out of plain sight, but it isn't real security: anyone
// using this browser can read the stored hashes. See mongo/SCHEMA.md.
const USERS_KEY = "equity_users";
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/; // same rule as mongo/users.validator.json
const MIN_PASSWORD_LENGTH = 8;
const PBKDF2_ITERATIONS = 600000; // OWASP's recommendation for PBKDF2-SHA256

function getUsers() {
  const users = readJson(USERS_KEY, []);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// Usernames are unique ignoring case ("Maria" and "maria" are one account), like the
// collection's case-insensitive index.
function findUser(username) {
  const key = String(username).toLowerCase();
  return getUsers().find((u) => u.username.toLowerCase() === key) || null;
}

function toBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

// "pbkdf2-sha256$<iterations>$<salt>$<hash>": the algorithm and cost are stored with the hash,
// so a server can still check it later and upgrade it to a stronger scheme on next login.
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, iterations, salt, expected] = passwordHash.split("$");
  if (scheme !== "pbkdf2-sha256") return false;
  return toBase64(await pbkdf2(password, fromBase64(salt), Number(iterations))) === expected;
}

// Creates an account and returns its username. Throws an Error whose message suits the form.
async function createAccount(username, password) {
  if (!USERNAME_PATTERN.test(username)) throw new Error("Use 3–30 letters, numbers, dots, dashes or underscores.");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (findUser(username)) throw new Error("That username is already taken.");
  const now = new Date().toISOString();
  // Signing up logs the new customer straight in, so it counts as their first login.
  const user = { username, passwordHash: await hashPassword(password), createdAt: now, lastLoginAt: now };
  saveUsers([...getUsers(), user]);
  return user.username;
}

// Checks a login. Returns the username as it was registered, or null if the username or
// password is wrong (the form doesn't say which).
async function logIn(username, password) {
  const user = findUser(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  const now = new Date().toISOString();
  saveUsers(getUsers().map((u) => (u.username === user.username ? { ...u, lastLoginAt: now } : u)));
  return user.username;
}

// The logged-in username, or null for a guest. Orders and quiz runs are saved under it.
function currentUsername() {
  const session = getSession();
  return session && session.loggedIn ? session.username : null;
}

// Quiz runs and orders made while logged out during this visit. sessionStorage ends with the
// tab, so logging in saves this visit's guest activity to the account without ever claiming
// an earlier visitor's orders on a shared computer.
const GUEST_ITEMS_KEY = "equity_guest_items";

function rememberGuestItem(kind, id) {
  if (currentUsername()) return;
  try {
    const items = JSON.parse(sessionStorage.getItem(GUEST_ITEMS_KEY)) || [];
    items.push({ kind, id });
    sessionStorage.setItem(GUEST_ITEMS_KEY, JSON.stringify(items));
  } catch {}
}

// Moves this visit's guest quiz runs and orders to `username`; returns how many of each moved.
function claimGuestItems(username) {
  let items = [];
  try {
    items = JSON.parse(sessionStorage.getItem(GUEST_ITEMS_KEY)) || [];
    sessionStorage.removeItem(GUEST_ITEMS_KEY);
  } catch {}
  const ids = (kind) => items.filter((item) => item.kind === kind).map((item) => item.id);
  const quizIds = ids("quiz");
  const orderIds = ids("order");
  const claimed = { quizzes: 0, orders: 0 };

  const results = getQuizResults().map((r) => {
    if (r.username !== null || !quizIds.includes(r.takenAt)) return r;
    claimed.quizzes++;
    return { ...r, username };
  });
  const orders = readJson(ORDERS_KEY, []).map((o) => {
    if ((o.username ?? null) !== null || !orderIds.includes(o.orderId)) return o;
    claimed.orders++;
    return { ...o, username };
  });
  try {
    localStorage.setItem(QUIZ_KEY, JSON.stringify(results));
    localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch {}
  return claimed;
}

// ---------- Data files (future MongoDB collections) ----------

async function loadJson(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    return await res.json();
  } catch (err) {
    // Opened from disk (file://), fetch() is blocked; use the copy in data/fallback.js.
    const fallback = window.EQUITY_FALLBACK_DATA && window.EQUITY_FALLBACK_DATA[path];
    if (fallback) return JSON.parse(JSON.stringify(fallback));
    throw err;
  }
}

const ROAST_ORDER = ["Light", "Medium", "Dark"];
// The shop's Origin filter order; the About page lists regions the same way.
const REGION_ORDER = ["South American", "Central American", "Asian", "South African", "Central African", "East African"];

async function getProducts() {
  return loadJson("data/products.json");
}

async function getProduct(id) {
  const products = await getProducts();
  return products.find((p) => p.id === id) || null;
}

// "South American" -> "region-south-american", matching the tag colors in styles.css.
function regionClass(region) {
  return `region-${region.toLowerCase().replace(/\s+/g, "-")}`;
}

// ---------- Prices + availability (fields match the MongoDB "products" collection) ----------

// salePrice is a number when the option is on sale, or null when it isn't.
function effectivePrice(option) {
  return option.salePrice ?? option.price;
}

function isOnSale(option) {
  return option.salePrice !== null && option.salePrice < option.price;
}

function availableOptions(product) {
  return product.options.filter((o) => o.available);
}

// A coffee can be bought when it's in stock and at least one option isn't sold out.
function isPurchasable(product) {
  return product.inStock && availableOptions(product).length > 0;
}

function lowestPrice(product) {
  const options = availableOptions(product);
  return Math.min(...(options.length ? options : product.options).map(effectivePrice));
}

function hasSale(product) {
  return availableOptions(product).some(isOnSale);
}

// ---------- Recommendations (matched on flavor groups, never roast) ----------

const FLAVOR_LABELS = {
  chocolate: "Chocolate",
  caramel: "Caramel & sweet",
  nutty: "Nutty",
  citrus: "Citrus",
  berry: "Berry",
  "stone-fruit": "Stone fruit",
  "orchard-fruit": "Orchard fruit",
  "dried-fruit": "Dried fruit",
  floral: "Floral",
  tea: "Tea-like",
  spice: "Spice",
  earthy: "Earthy",
};

function flavorLabel(flavor) {
  return FLAVOR_LABELS[flavor] || flavor;
}

// Ranks coffees by how many flavor groups they share with `flavors`, skipping `excludeIds`.
// Ties go to the closer overall profile (Jaccard similarity), then name.
function recommendForFlavors(flavors, excludeIds, products, limit = 3) {
  return products
    .filter((p) => !excludeIds.includes(p.id) && isPurchasable(p))
    .map((p) => {
      const shared = p.flavors.filter((f) => flavors.includes(f));
      const union = new Set([...p.flavors, ...flavors]).size;
      return { product: p, shared, similarity: shared.length / union };
    })
    .filter((match) => match.shared.length > 0)
    .sort(
      (a, b) =>
        b.shared.length - a.shared.length ||
        b.similarity - a.similarity ||
        a.product.name.localeCompare(b.product.name)
    )
    .slice(0, limit);
}

function recommendFor(product, products, limit = 3) {
  return recommendForFlavors(product.flavors, [product.id], products, limit);
}

// Matches for everything in the cart combined, never suggesting what's already in it.
function recommendForCart(products, limit = 3) {
  const cartIds = [...new Set(getCart().map((line) => line.productId))];
  const cartProducts = products.filter((p) => cartIds.includes(p.id));
  const flavors = [...new Set(cartProducts.flatMap((p) => p.flavors))];
  return recommendForFlavors(flavors, cartIds, products, limit);
}

// `matches` are { product, shared } entries from the recommend functions above.
function renderRecItems(matches) {
  return matches
    .map(
      ({ product: p, shared }) => `
    <a class="rec-item" href="product.html?id=${encodeURIComponent(p.id)}">
      <img src="${escapeHtml(p.image)}" alt="" data-roast="${p.roast.toLowerCase()}" />
      <div>
        <strong>${escapeHtml(p.name)}</strong>
        <span class="muted">${escapeHtml(p.tastingNotes)}</span>
        ${
          shared && shared.length
            ? `<div class="rec-shared">${shared.map((f) => `<span class="tag">${escapeHtml(flavorLabel(f))}</span>`).join("")}</div>`
            : ""
        }
        <span class="rec-price">From ${formatMoney(lowestPrice(p))}</span>
      </div>
    </a>`
    )
    .join("");
}

const QUIZ_KEY = "equity_quiz";

// Every quiz run, oldest first: its top matches (best first), when it was taken, and who took
// it (`username`, or null when logged out). Browsers from before accounts saved a single
// result object; that one is read as a guest run.
function getQuizResults() {
  const stored = readJson(QUIZ_KEY, []);
  const runs = Array.isArray(stored) ? stored : stored && stored.productIds ? [stored] : [];
  return runs
    .filter((r) => Array.isArray(r.productIds))
    .map((r) => ({ ...r, username: r.username ?? null, productIds: r.productIds.map(currentProductId) }));
}

function saveQuizResult(productIds) {
  const result = { username: currentUsername(), productIds, takenAt: new Date().toISOString() };
  try {
    localStorage.setItem(QUIZ_KEY, JSON.stringify([...getQuizResults(), result]));
  } catch {}
  rememberGuestItem("quiz", result.takenAt);
}

// The latest run for whoever is browsing: their own when logged in, a guest run otherwise.
// The shop sidebar shows its matches.
function getQuizResult() {
  const username = currentUsername();
  return getQuizResults().filter((r) => r.username === username).at(-1) || null;
}

const LAST_VIEWED_KEY = "equity_last_viewed";

function setLastViewed(productId) {
  try {
    localStorage.setItem(LAST_VIEWED_KEY, productId);
  } catch {}
}

function getLastViewed() {
  try {
    const id = localStorage.getItem(LAST_VIEWED_KEY);
    return id && currentProductId(id);
  } catch {
    return null;
  }
}

// ---------- Reviews ----------

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

// Reviews saved before products had IDs all belong to the original product.
const LEGACY_PRODUCT_ID = "1001";

// Product IDs used to be text slugs before they became four-digit codes. Anything a
// browser saved under an old slug (cart, reviews, quiz, links) is translated on read.
const OLD_PRODUCT_IDS = {
  "aprysa-peru": "1001",
  "huila-colombia": "1002",
  "cerrado-brazil": "1003",
  "antigua-guatemala": "1004",
  "tarrazu-costa-rica": "1005",
  "marcala-honduras": "1006",
  "mandheling-sumatra": "1007",
  "malabar-india": "1008",
  "dalat-vietnam": "1009",
  "mzuzu-malawi": "1010",
  "kasama-zambia": "1011",
  "kivu-rwanda": "1012",
  "kayanza-burundi": "1013",
  "kivu-congo": "1014",
};

function currentProductId(id) {
  return OLD_PRODUCT_IDS[id] || id;
}

function getUserReviews() {
  const stored = readJson(REVIEWS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.map((r) => ({ ...r, productId: currentProductId(r.productId || LEGACY_PRODUCT_ID) }));
}

// Seed reviews come from data/reviews.json; reviews added by users live in localStorage.
// Pass a productId to get only that product's reviews.
async function getReviews(productId) {
  const seed = await loadJson("data/reviews.json");
  const isSeed = (r) => seed.some((s) => s.name === r.name && s.date === r.date);
  const userReviews = getUserReviews().filter((r) => !isSeed(r));
  const all = [...userReviews, ...seed];
  return productId ? all.filter((r) => r.productId === productId) : all;
}

function addReview(review) {
  const userReviews = getUserReviews();
  userReviews.unshift(review);
  localStorage.setItem(REVIEWS_KEY, JSON.stringify(userReviews));
}

// Today's date as YYYY-MM-DD in the customer's own time zone. (toISOString() uses UTC,
// which is already "tomorrow" on a US evening.)
function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function averageRating(reviews) {
  if (!reviews.length) return 0;
  const total = reviews.reduce((sum, r) => sum + r.rating, 0);
  return total / reviews.length;
}

function renderStars(rating) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  return `<span class="stars-outer">★★★★★<span class="stars-inner" style="width:${pct}%">★★★★★</span></span>`;
}

// ---------- Cart ----------

function getCart() {
  const cart = readJson(CART_KEY, []);
  if (!Array.isArray(cart)) return [];
  return cart.map((line) => ({ ...line, productId: currentProductId(line.productId) }));
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  refreshCartBadge();
}

function isValidQty(qty) {
  return Number.isInteger(qty) && qty >= 1 && qty <= MAX_QTY;
}

function addToCart(item) {
  const cart = getCart();
  const existing = cart.find((line) => line.productId === item.productId && line.option === item.option);
  if (existing) {
    existing.qty = Math.min(MAX_QTY, existing.qty + item.qty);
  } else {
    cart.push({ ...item });
  }
  saveCart(cart);
  return cart;
}

function updateQty(index, qty) {
  const cart = getCart();
  if (!cart[index] || !isValidQty(qty)) return cart;
  cart[index].qty = qty;
  saveCart(cart);
  return cart;
}

function removeFromCart(index) {
  const cart = getCart();
  cart.splice(index, 1);
  saveCart(cart);
  return cart;
}

function clearCart() {
  saveCart([]);
}

function cartCount() {
  return getCart().reduce((sum, line) => sum + line.qty, 0);
}

function cartTotals(cart = getCart()) {
  const subtotal = cart.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
  return { subtotal, shipping, total: subtotal + shipping };
}

function formatMoney(amount) {
  return `$${amount.toFixed(2)}`;
}

// ---------- Orders ----------

function saveOrder(order) {
  const orders = readJson(ORDERS_KEY, []);
  orders.push(order);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  rememberGuestItem("order", order.orderId);
}

// ---------- Contact messages ----------

// Messages from the contact page, shaped like the messages collection (see mongo/SCHEMA.md).
const MESSAGES_KEY = "equity_messages";

function saveMessage(message) {
  const messages = readJson(MESSAGES_KEY, []);
  messages.push(message);
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
}

// An account's orders, newest first. Orders from before accounts have no username: guest orders.
function getOrders(username) {
  return readJson(ORDERS_KEY, [])
    .filter((o) => (o.username ?? null) === username)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- Icon toolbar menus (shop + reviews) ----------

// `menus` maps a menu name to its options: { region: [{ value, label }, ...] }.
// Each `.icon-btn[data-menu="name"]` inside `root` opens `#menu-name`.
// Picking an option writes it to `state[name]` and calls `onChange()`.
function setupIconMenus({ root, menus, state, defaults, onChange }) {
  const buttons = [...root.querySelectorAll(".icon-btn[data-menu]")];
  const menuEl = (btn) => document.getElementById(`menu-${btn.dataset.menu}`);

  function renderMenu(btn) {
    const name = btn.dataset.menu;
    menuEl(btn).innerHTML = menus[name]
      .map(
        (o) =>
          `<button type="button" role="menuitemradio" class="icon-menu-item" data-value="${escapeHtml(o.value)}" aria-checked="${state[name] === o.value}">${escapeHtml(o.label)}</button>`
      )
      .join("");
  }

  function closeAll(focusButton) {
    buttons.forEach((btn) => {
      const wasOpen = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", "false");
      menuEl(btn).hidden = true;
      if (wasOpen && focusButton) btn.focus();
    });
  }

  function open(btn) {
    closeAll(false);
    renderMenu(btn);
    const el = menuEl(btn);
    el.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    (el.querySelector("[aria-checked=true]") || el.firstElementChild).focus();
  }

  buttons.forEach((btn) => {
    const el = menuEl(btn);

    btn.addEventListener("click", () => {
      btn.getAttribute("aria-expanded") === "true" ? closeAll(true) : open(btn);
    });

    el.addEventListener("click", (e) => {
      const item = e.target.closest(".icon-menu-item");
      if (!item) return;
      state[btn.dataset.menu] = item.dataset.value;
      closeAll(true);
      onChange();
    });

    // Arrow keys move through the options.
    el.addEventListener("keydown", (e) => {
      const items = [...el.querySelectorAll(".icon-menu-item")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
      else return;
      e.preventDefault();
    });
  });

  // Clicking anywhere else, or pressing Escape, closes an open menu.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".icon-control")) closeAll(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll(true);
  });

  return {
    // Copper dot on any icon whose setting differs from its default.
    refreshIndicators() {
      buttons.forEach((btn) => {
        btn.classList.toggle("has-value", state[btn.dataset.menu] !== defaults[btn.dataset.menu]);
      });
    },
  };
}

function menuLabel(menus, name, value) {
  const option = menus[name].find((o) => o.value === value);
  return option ? option.label : value;
}

// Removable chips for active filters, plus a note when the sort isn't the default.
function renderFilterChips(el, { menus, state, defaults, filters, sortKey }) {
  const chips = filters
    .filter((name) => state[name] !== defaults[name])
    .map((name) => {
      const label = escapeHtml(menuLabel(menus, name, state[name]));
      return `<button type="button" class="filter-chip" data-clear="${name}" aria-label="Remove ${label} filter">${label} <span aria-hidden="true">×</span></button>`;
    });
  if (sortKey && state[sortKey] !== defaults[sortKey]) {
    chips.push(`<span class="sort-note">Sorted by ${escapeHtml(menuLabel(menus, sortKey, state[sortKey]).toLowerCase())}</span>`);
  }
  el.innerHTML = chips.join("");
}

function setupChipClearing(el, { state, defaults, onChange }) {
  el.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-clear]");
    if (!chip) return;
    state[chip.dataset.clear] = defaults[chip.dataset.clear];
    onChange();
  });
}

// ---------- Shared page pieces ----------

// Step indicator for the purchase flow; `current` is 0 (cart), 1 (checkout) or 2 (done).
function renderSteps(current) {
  const steps = ["Cart", "Checkout", "Confirmation"];
  return `<ol class="steps">${steps
    .map((label, i) => {
      const status = i < current ? "done" : i === current ? "current" : "upcoming";
      const aria = i === current ? ' aria-current="step"' : "";
      return `<li class="step ${status}"${aria}><span class="step-dot">${i < current ? "✓" : i + 1}</span>${label}</li>`;
    })
    .join("")}</ol>`;
}

// Small roast-tinted thumbnail; falls back to the shared photo if the product is unknown.
function renderThumb(product) {
  const roast = product ? product.roast.toLowerCase() : "medium";
  const src = product ? product.image : "coffee-beans.jpg";
  return `<img class="line-thumb" src="${escapeHtml(src)}" alt="" data-roast="${roast}" />`;
}

function renderProductTags(product) {
  if (!product) return "";
  let tags = `<span class="tag ${regionClass(product.region)}">${escapeHtml(product.region)}</span>
    <span class="tag roast-${product.roast.toLowerCase()}">${escapeHtml(product.roast)} roast</span>`;
  if (!product.inStock) tags += `<span class="tag tag-stock">Out of stock</span>`;
  else if (hasSale(product)) tags += `<span class="tag tag-sale">On sale</span>`;
  return tags;
}

// ---------- Navigation ----------

function refreshCartBadge() {
  const badge = document.getElementById("cart-count");
  if (badge) badge.textContent = cartCount();
}

function renderNav(activePage) {
  const session = getSession();
  const mount = document.getElementById("site-header");
  if (!mount) return;

  const links = [
    { href: "index.html", label: "Shop" },
    { href: "reviews.html", label: "Reviews" },
    { href: "quiz.html", label: "Quiz" },
  ];

  const navLinks = links
    .map(
      (l) =>
        `<a href="${l.href}" class="${activePage === l.href ? "active" : ""}">${l.label}</a>`
    )
    .join("");

  const cartLink = `<a href="cart.html" class="cart-link ${activePage === "cart.html" ? "active" : ""}">Cart <span class="cart-badge" id="cart-count">${cartCount()}</span></a>`;

  let userSection;
  if (session && session.loggedIn) {
    userSection = `
      <div class="nav-user">
        <a href="account.html" class="${activePage === "account.html" ? "active" : ""}">Welcome, ${escapeHtml(session.username)}</a>
        <button id="logout-btn" type="button">Log out</button>
      </div>`;
  } else {
    userSection = `
      <div class="nav-user">
        <a href="login.html" class="${activePage === "login.html" ? "active" : ""}">Log in</a>
      </div>`;
  }

  mount.innerHTML = `
    <div class="nav-inner">
      <a href="index.html" class="brand">Equity Beans</a>
      <nav class="main-nav">
        ${navLinks}
        ${cartLink}
        ${userSection}
      </nav>
    </div>`;

  renderFooter(activePage);

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearSession();
      renderNav(activePage);
      // Pages that show account data (reviews form, shop sidebar, account page) refresh here.
      if (typeof window.onSessionChanged === "function") {
        window.onSessionChanged();
      }
    });
  }
}

// Footer on every page (called by renderNav, so it also updates on log out). The header keeps
// to the main shopping links; the footer adds About, FAQ and Contact.
function renderFooter(activePage) {
  const mount = document.getElementById("site-footer");
  if (!mount) return;

  const account = currentUsername()
    ? { href: "account.html", label: "Your account" }
    : { href: "login.html", label: "Log in" };
  const links = [
    { href: "index.html", label: "Shop" },
    { href: "quiz.html", label: "Coffee quiz" },
    { href: "reviews.html", label: "Reviews" },
    { href: "about.html", label: "About" },
    { href: "faq.html", label: "FAQ" },
    { href: "contact.html", label: "Contact" },
    account,
  ];

  mount.innerHTML = `
    <div class="footer-inner">
      <div class="footer-brand">
        <a href="index.html" class="brand">Equity Beans</a>
        <p>Fair Trade, single-origin coffee from six growing regions.</p>
      </div>
      <nav class="footer-nav" aria-label="Footer">
        ${links
          .map((l) => `<a href="${l.href}" class="${activePage === l.href ? "active" : ""}">${l.label}</a>`)
          .join("")}
      </nav>
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
