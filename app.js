const SESSION_KEY = "aurora_session";
const CART_KEY = "equity_cart";

const MAX_QTY = 10;
const SHIPPING_FEE = 5.0;
const FREE_SHIPPING_MIN = 100.0;

// ---------- Server API ----------

// Accounts, reviews, orders, quiz results and messages live in MongoDB behind server.js.
// Without it (a page opened from disk, or another static server) only reading products and
// reviews works, from data/fallback.js.
const SERVER_NEEDED = "This needs the Equity Beans server. Start it with npm start, then open http://localhost:3000.";

// Calls the API and returns its JSON. Throws an Error whose message suits the page: the
// server's own message for a rejected request, or SERVER_NEEDED when there's no server.
async function api(path, { method = "GET", body } = {}) {
  const sendsJson = method !== "GET";
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: sendsJson ? { "Content-Type": "application/json" } : {},
      body: sendsJson ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new Error(SERVER_NEEDED);
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok || data === undefined) {
    throw Object.assign(new Error((data && data.error) || SERVER_NEEDED), { status: res.status });
  }
  return data;
}

// Before the server, accounts, reviews, orders, quiz runs and messages were kept in this
// browser. They're in MongoDB now, so the old copies are removed.
try {
  ["equity_users", "aurora_reviews", "equity_orders", "equity_quiz", "equity_messages"].forEach((key) => localStorage.removeItem(key));
  sessionStorage.removeItem("equity_guest_items");
} catch {}

// ---------- Session ----------

// The server decides who is logged in, with an httpOnly cookie. This browser keeps only a copy
// of the username so the header can draw straight away; renderNav() checks it with the server.
function getSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY));
    return session && session.loggedIn ? session : null;
  } catch {
    return null;
  }
}

// `role` only decides whether the header shows the Admin link; the server checks the real role
// on every admin request.
function setSession(username, role = "customer") {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ loggedIn: true, username, role }));
  } catch {}
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

// The logged-in username, or null for a guest.
function currentUsername() {
  const session = getSession();
  return session ? session.username : null;
}

// Asks the server who is logged in. When that differs from the copy the page drew with, the
// header redraws and the page's onSessionChanged() runs. No server counts as logged out.
async function refreshSession(activePage) {
  let username = null;
  let role = null;
  try {
    ({ username, role } = await api("api/session"));
  } catch {}
  const cached = getSession();
  if (username === currentUsername() && (!username || role === cached.role)) return;
  username ? setSession(username, role) : clearSession();
  renderNav(activePage);
  if (typeof window.onSessionChanged === "function") window.onSessionChanged();
}

// ---------- Accounts ----------

// Same rules as server.js and mongo/users.validator.json, so the forms can check as you type.
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;

// What customers and the admin page call each order status (the orders validator's enum).
const ORDER_STATUS_LABELS = {
  pending_payment: "Awaiting payment",
  paid: "Paid",
  shipped: "Shipped",
  cancelled: "Cancelled",
};

// Both return { username, claimed: { quizzes, orders } }: logging in moves the quiz runs and
// orders made as a guest during this visit to the account. Both throw an Error whose message
// suits the form ("That username is already taken.", "Username or password is incorrect.").
// `securityQuestions` is [{ questionId, answer }, { questionId, answer }].
async function createAccount(username, password, securityQuestions) {
  const result = await api("api/signup", { method: "POST", body: { username, password, securityQuestions } });
  setSession(result.username, result.role);
  return result;
}

async function logIn(username, password) {
  const result = await api("api/login", { method: "POST", body: { username, password } });
  setSession(result.username, result.role);
  return result;
}

async function logOut() {
  try {
    await api("api/logout", { method: "POST" });
  } catch (err) {
    console.error(err);
  }
  clearSession();
}

// { username, securityQuestions }: the wording of the account's two questions, or null for
// accounts made before sign-up asked for them.
function getAccount() {
  return api("api/me");
}

// [{ id, question }]: the questions to choose from.
function getSecurityQuestionList() {
  return api("api/security-questions");
}

// Other devices are logged out; this one stays logged in.
function changePassword(currentPassword, newPassword) {
  return api("api/me/password", { method: "POST", body: { currentPassword, newPassword } });
}

// Changing the questions takes the current password.
function updateSecurityQuestions(securityQuestions, password) {
  return api("api/me/security-questions", { method: "POST", body: { securityQuestions, password } });
}

// The two questions to answer for `username`. Unknown usernames get questions too, so the
// form doesn't reveal which accounts exist.
async function getResetQuestions(username) {
  return (await api("api/password/questions", { method: "POST", body: { username } })).questions;
}

// Checks both answers, sets the new password and logs in, like logIn().
async function resetPassword(username, answers, password) {
  const result = await api("api/password/reset", { method: "POST", body: { username, answers, password } });
  setSession(result.username, result.role);
  return result;
}

// Same rule as server.js (MIN_ANSWER_LENGTH); the inputs' maxlength covers the upper limit.
const MIN_ANSWER_LENGTH = 2;

function securityAnswerError(value) {
  return value.trim().replace(/\s+/g, " ").length >= MIN_ANSWER_LENGTH ? "" : `Please write an answer (at least ${MIN_ANSWER_LENGTH} characters).`;
}

// Builds the two question dropdowns used on sign-up and the account page. Choosing a question
// in one dropdown hides it in the other, so the same question can't be picked twice.
function fillQuestionSelects(selects, questions) {
  const update = () => {
    selects.forEach((select) => {
      const taken = selects.filter((other) => other !== select).map((other) => other.value);
      // hidden for most browsers, disabled for Safari, which shows hidden options anyway
      [...select.options].forEach((option) => (option.hidden = option.disabled = option.value !== "" && taken.includes(option.value)));
    });
  };
  selects.forEach((select) => {
    select.innerHTML =
      `<option value="">Choose a question</option>` +
      questions.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.question)}</option>`).join("");
    select.addEventListener("change", update);
  });
}

// ---------- Products + reviews (read-only fallback when there's no server) ----------

// Reads from the API. If the server isn't running, uses the copy of `fallbackPath` (one of the
// data/*.json files) bundled in data/fallback.js.
async function loadJson(apiPath, fallbackPath) {
  try {
    return await api(apiPath);
  } catch (err) {
    const fallback = window.EQUITY_FALLBACK_DATA && window.EQUITY_FALLBACK_DATA[fallbackPath];
    if (fallback) return JSON.parse(JSON.stringify(fallback));
    throw err;
  }
}

const ROAST_ORDER = ["Light", "Medium", "Dark"];
// The shop's Origin filter order; the About page lists regions the same way.
const REGION_ORDER = ["South American", "Central American", "Asian", "South African", "Central African", "East African"];

async function getProducts() {
  return loadJson("api/products", "data/products.json");
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

// Saves a quiz run's top matches (best first) to the quizResults collection, under the
// logged-in account or this visit's guest session.
async function saveQuizResult(productIds) {
  return api("api/quiz-results", { method: "POST", body: { productIds } });
}

// The latest run for whoever is browsing: their own when logged in, this visit's guest run
// otherwise. The shop sidebar shows its matches. null when there's none (or no server).
async function getQuizResult() {
  try {
    return await api("api/quiz-results/latest");
  } catch {
    return null;
  }
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

// The original coffee: product.html shows it when the link has no ?id=.
const LEGACY_PRODUCT_ID = "1001";

// Product IDs used to be text slugs before they became four-digit codes. Anything a
// browser saved under an old slug (cart, last viewed, links) is translated on read.
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

// Reviews from the reviews collection, newest first. Pass a productId to get only that
// product's reviews. Without a server, the seed reviews in data/reviews.json.
async function getReviews(productId) {
  const query = productId ? `?productId=${encodeURIComponent(productId)}` : "";
  const reviews = await loadJson(`api/reviews${query}`, "data/reviews.json");
  return productId ? reviews.filter((r) => r.productId === productId) : reviews;
}

// The logged-in account's own reviews, newest first.
async function getMyReviews() {
  return api("api/me/reviews");
}

// `review` is { productId, rating, comment, date }; the server adds who wrote it.
async function addReview(review) {
  return api("api/reviews", { method: "POST", body: review });
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

// Average rating and review count per product: { "1001": { total, count, avg }, ... }.
function ratingsByProduct(reviews) {
  const ratings = {};
  reviews.forEach((r) => {
    const entry = (ratings[r.productId] ||= { total: 0, count: 0 });
    entry.total += r.rating;
    entry.count += 1;
    entry.avg = entry.total / entry.count;
  });
  return ratings;
}

// A coffee card linking to its product page (shop grid and Home's featured coffees).
// `rating` is that coffee's entry from ratingsByProduct(), if it has reviews.
function renderProductCard(p, rating) {
  const ratingLine = rating
    ? `${renderStars(rating.avg)} <span class="muted">(${rating.count})</span>`
    : `<span class="muted">No reviews yet</span>`;
  return `
    <a class="card product-card" href="product.html?id=${encodeURIComponent(p.id)}">
      <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.imageAlt)}" data-roast="${p.roast.toLowerCase()}" loading="lazy" />
      <div class="product-card-body">
        <div class="product-tags">${renderProductTags(p)}</div>
        <h2>${escapeHtml(p.name)}</h2>
        <p class="muted">${escapeHtml(p.country)} · ${escapeHtml(p.tastingNotes)}</p>
        <div class="product-card-rating">${ratingLine}</div>
        <div class="product-card-price">${isPurchasable(p) ? `From ${formatMoney(lowestPrice(p))}` : `<span class="muted">Currently unavailable</span>`}</div>
      </div>
    </a>`;
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

// Places an order for the cart's lines. The server looks up the prices itself and returns the
// saved order: { orderId, username, customer, items, totals, amountCents, status, createdAt }.
async function saveOrder(customer, cart = getCart()) {
  const items = cart.map(({ productId, option, qty }) => ({ productId, option, qty }));
  return api("api/orders", { method: "POST", body: { customer, items } });
}

// The logged-in account's orders, newest first.
async function getOrders() {
  return api("api/orders");
}

// ---------- Contact messages ----------

// `message` is { name, email, topic, orderId, message }; the server adds who sent it, the
// status and the time (see the messages collection in mongo/SCHEMA.md).
async function saveMessage(message) {
  return api("api/messages", { method: "POST", body: message });
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

let sessionChecked = false;

function renderNav(activePage) {
  const session = getSession();
  const mount = document.getElementById("site-header");
  if (!mount) return;

  const links = [
    { href: "index.html", label: "Home" },
    { href: "shop.html", label: "Shop" },
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
    const adminLink =
      session.role === "admin" ? `<a href="admin/">Admin</a>` : ""; // the Angular admin app (admin-app/)
    userSection = `
      ${adminLink}
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

  // The first draw used this browser's copy of the session; check it with the server once.
  if (!sessionChecked) {
    sessionChecked = true;
    refreshSession(activePage);
  }

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      logoutBtn.disabled = true;
      await logOut();
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
    { href: "index.html", label: "Home" },
    { href: "shop.html", label: "Shop" },
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
