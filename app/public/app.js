// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  'use strict';

  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs');
  const who = document.getElementById('who');
  const toastEl = document.getElementById('toast');
  const state = { user: null, chains: [], states: [], today: '', stores: [], tab: 'scan', stream: null, timer: null };

  // Build DOM nodes without innerHTML so product and store names can never inject markup.
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path, { method = 'GET', body, raw, type } = {}) {
    const headers = { 'X-Requested-With': 'pricebook' };
    let payload;
    if (raw) { payload = raw; headers['Content-Type'] = type || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    let response;
    try { response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' }); }
    catch { throw new Error('Could not reach the server. Check your connection.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && state.user) { state.user = null; showAuth(); }
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.className = isError ? 'toast error' : 'toast';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 2500);
  }
  const guard = (fn) => async (event) => {
    if (event) event.preventDefault();
    const button = event && event.submitter ? event.submitter : event && event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    if (button) button.disabled = true;
    try { await fn(event); } catch (error) { toast(error.message, true); } finally { if (button) button.disabled = false; }
  };
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const storeLabel = (store) => `${store.chain} ${store.suburb}`;
  const field = (label, input) => h('label', {}, label, input);
  function statusTag(price) {
    return [
      price.onSpecial ? h('span', { class: 'tag special' }, 'special') : null,
      price.status === 'verified' ? h('span', { class: 'tag verified' }, 'confirmed')
        : price.status === 'receipt' ? h('span', { class: 'tag' }, 'receipt attached')
          : price.status === 'held' ? h('span', { class: 'tag special' }, 'needs a receipt')
            : price.status === 'held_receipt' ? h('span', { class: 'tag special' }, 'waiting for confirmation') : null
    ];
  }

  function stopCamera() {
    clearInterval(state.timer); state.timer = null;
    if (state.stream) { for (const track of state.stream.getTracks()) track.stop(); state.stream = null; }
  }

  // ── sign in / register ────────────────────────────────────────────────────
  function showAuth(hasUsers = true) {
    stopCamera();
    tabs.hidden = true; who.textContent = '';
    let registering = !hasUsers;
    const draw = () => {
      const username = h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true });
      const password = h('input', { name: 'password', type: 'password', autocomplete: registering ? 'new-password' : 'current-password', required: true, minlength: registering ? 10 : null });
      const displayName = h('input', { name: 'displayName', autocomplete: 'name', placeholder: 'Shown next to your prices' });
      const invite = h('input', { name: 'invite', autocapitalize: 'characters', placeholder: 'From whoever invited you' });
      const submit = guard(async () => {
        const body = { username: username.value, password: password.value };
        if (registering) { body.displayName = displayName.value; body.invite = invite.value; }
        const data = await api(registering ? '/api/register' : '/api/login', { method: 'POST', body });
        state.user = data.user;
        await enter();
      });
      view.replaceChildren(h('form', { class: 'card', onsubmit: submit },
        h('h2', {}, registering ? (hasUsers ? 'Create your account' : 'Set up the first account') : 'Sign in'),
        !hasUsers ? h('p', { class: 'muted' }, 'Nobody has an account yet. The first account becomes the admin.') : null,
        field('Username', username),
        registering ? field('Your name', displayName) : null,
        field(registering ? 'Password (at least 10 characters)' : 'Password', password),
        registering && hasUsers ? field('Invite code', invite) : null,
        h('button', { class: 'primary', type: 'submit' }, registering ? 'Create account' : 'Sign in'),
        hasUsers ? h('button', { class: 'link', type: 'button', onclick: () => { registering = !registering; draw(); } }, registering ? 'I already have an account' : 'I have an invite code') : null
      ));
    };
    draw();
  }

  async function loadStores() { state.stores = (await api('/api/stores')).stores; }
  function storeSelect() {
    const select = h('select', { required: true }, h('option', { value: '' }, state.stores.length ? 'Choose a store' : 'Add a store first (Stores tab)'));
    for (const store of state.stores) select.append(h('option', { value: store.id }, `${storeLabel(store)}, ${store.state}`));
    const last = localStorage.getItem('pb_store');
    if (last && state.stores.some((store) => String(store.id) === last)) select.value = last;
    select.addEventListener('change', () => localStorage.setItem('pb_store', select.value));
    return select;
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  function showScan() {
    const result = h('div', { class: 'view', style: null });
    result.style.padding = '0';
    const video = h('video', { playsinline: true, muted: true, hidden: true });
    const code = h('input', { inputmode: 'numeric', pattern: '[0-9]{8,14}', placeholder: 'Or type the barcode', required: true });
    const lookup = async (barcode) => {
      const data = await api(`/api/products/${encodeURIComponent(String(barcode).replace(/\D/g, ''))}`);
      code.value = data.barcode;
      drawProduct(result, data);
    };
    const cameraButton = h('button', { class: 'primary', type: 'button', onclick: guard(async () => {
      // Inside the Android app, use the phone's own scanner screen instead of the in-page camera.
      if (window.PricebookNative) {
        window.pricebookScanned = (value) => guard(() => lookup(value))();
        window.pricebookScanFailed = (message) => { if (message) toast(message, true); };
        window.PricebookNative.scan();
        return;
      }
      if (state.stream) { stopCamera(); video.hidden = true; cameraButton.textContent = 'Scan with camera'; return; }
      if (!('BarcodeDetector' in window)) throw new Error('This browser cannot scan barcodes. Use Chrome on Android, or type the number under the barcode.');
      const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = state.stream; video.hidden = false; await video.play();
      cameraButton.textContent = 'Stop camera';
      state.timer = setInterval(async () => {
        try {
          const found = await detector.detect(video);
          if (!found.length) return;
          stopCamera(); video.hidden = true; cameraButton.textContent = 'Scan with camera';
          if (navigator.vibrate) navigator.vibrate(60);
          await lookup(found[0].rawValue);
        } catch (error) { if (!state.stream) toast(error.message, true); }
      }, 350);
    }) }, 'Scan with camera');
    view.replaceChildren(
      h('section', { class: 'card' }, h('h2', {}, 'Scan a product'), cameraButton, video,
        h('form', { class: 'row', onsubmit: guard(() => lookup(code.value)) }, code, h('button', { type: 'submit' }, 'Look up'))),
      result);
  }

  function drawProduct(container, data) {
    const nodes = [];
    if (!data.found) {
      const name = h('input', { required: true, minlength: 2, placeholder: 'e.g. Full Cream Milk' });
      const brand = h('input', { placeholder: 'e.g. Dairy Farmers' });
      const size = h('input', { placeholder: 'e.g. 2 L' });
      nodes.push(h('form', { class: 'card', onsubmit: guard(async () => {
        const saved = await api(`/api/products/${data.barcode}`, { method: 'PUT', body: { name: name.value, brand: brand.value, size: size.value } });
        toast('Product saved');
        drawProduct(container, { ...data, found: true, product: saved.product });
      }) },
        h('h2', {}, 'New product'), h('p', { class: 'muted' }, `Barcode ${data.barcode} is not in Open Food Facts yet. Name it once and everyone gets it.`),
        field('Name', name), h('div', { class: 'row' }, field('Brand', brand), field('Size', size)),
        h('button', { class: 'primary', type: 'submit' }, 'Save product')));
      container.replaceChildren(...nodes);
      return;
    }
    const product = data.product;
    const store = storeSelect();
    const price = h('input', { inputmode: 'decimal', placeholder: '0.00', required: true });
    const special = h('input', { type: 'checkbox' });
    const was = h('input', { inputmode: 'decimal', placeholder: 'Usual price (optional)' });
    const wasField = field('Usual price', was); wasField.hidden = true;
    special.addEventListener('change', () => { wasField.hidden = !special.checked; });
    const date = h('input', { type: 'date', value: state.today, max: state.today, required: true });
    nodes.push(h('form', { class: 'card', onsubmit: guard(async () => {
      const saved = await api('/api/prices', { method: 'POST', body: { barcode: data.barcode, storeId: Number(store.value), price: price.value, onSpecial: special.checked, wasPrice: special.checked ? was.value : '', observedOn: date.value } });
      if (saved.held) {
        const why = saved.heldReason === 'low' ? `less than half the usual ${money(saved.usual.priceCents)}` : `more than ${saved.maxOverPercent}% above the usual ${money(saved.usual.priceCents)}`;
        toast(`Saved, but that is ${why}. It will not count until you add a receipt or a photo of the price tag (see Prices).`, true);
      } else toast('Price saved');
      drawProduct(container, { ...data, latest: saved.latest, history: saved.history, typical: saved.typical });
    }) },
      h('div', { class: 'product' }, product.imageUrl ? h('img', { src: product.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        h('div', {}, h('strong', {}, product.name), h('span', { class: 'muted' }, [product.brand, product.size, data.barcode].filter(Boolean).join(' · ')))),
      field('Store', store),
      h('div', { class: 'row' }, field('Price you saw ($)', price), field('Date', date)),
      h('label', { class: 'check' }, special, 'It was on special'), wasField,
      h('button', { class: 'primary', type: 'submit' }, 'Save price')));
    nodes.push(h('section', { class: 'card' }, h('h2', {}, 'Latest price at each store'),
      data.typical ? h('p', { class: 'muted' }, `Typical price ${money(data.typical.priceCents)} across ${data.typical.stores} store${data.typical.stores === 1 ? '' : 's'} (specials not counted).`) : null,
      data.latest.length ? h('ul', { class: 'list' }, data.latest.map((row) => h('li', {},
        h('span', {}, storeLabel(row), h('span', { class: 'muted' }, ` · ${row.observedOn}`), statusTag(row)), h('span', { class: 'price' }, money(row.priceCents)))))
        : h('p', { class: 'muted' }, 'No prices yet. Yours will be the first.')));
    if (data.history.length > data.latest.length) {
      nodes.push(h('section', { class: 'card' }, h('h2', {}, 'History'), h('ul', { class: 'list' }, data.history.map((row) => h('li', {},
        h('span', {}, `${row.observedOn} · ${storeLabel(row)}`, statusTag(row)), h('span', { class: 'price' }, money(row.priceCents)))))));
    }
    container.replaceChildren(...nodes);
    price.focus();
  }

  // A photo of the shelf price tag backs up one price (a receipt backs up a whole trip).
  function tagUpload(row, done) {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', guard(async () => {
      const photo = input.files[0];
      if (!photo) return;
      const saved = await api(`/api/receipts?kind=tag&priceId=${row.id}`, { method: 'POST', raw: photo, type: photo.type });
      toast(saved.aiCheck ? 'Photo added. It is being checked now.' : 'Photo added. It will count once it is confirmed.');
      await done();
    }));
    return h('span', {}, input, h('button', { class: 'link', type: 'button', onclick: () => input.click() }, 'Add price tag photo'));
  }

  // ── prices ────────────────────────────────────────────────────────────────
  async function showPrices(mine = true) {
    const data = await api(`/api/prices${mine ? '?mine=1' : ''}`);
    view.replaceChildren(h('section', { class: 'card' },
      h('div', { class: 'row' },
        h('button', { type: 'button', class: mine ? 'primary' : '', onclick: guard(() => showPrices(true)) }, 'Mine'),
        h('button', { type: 'button', class: mine ? '' : 'primary', onclick: guard(() => showPrices(false)) }, 'Everyone')),
      data.prices.length ? h('ul', { class: 'list' }, data.prices.map((row) => h('li', {},
        h('span', {}, h('strong', {}, row.name), h('br'), h('span', { class: 'muted' }, [row.brand, row.size, storeLabel(row), row.observedOn, mine ? null : row.addedBy].filter(Boolean).join(' · ')), statusTag(row)),
        h('span', {}, h('span', { class: 'price' }, money(row.priceCents)),
          row.userId === state.user.id && row.status === 'held' ? tagUpload(row, () => showPrices(mine)) : null,
          (row.userId === state.user.id && row.status !== 'verified') || state.user.role === 'admin'
            ? h('button', { class: 'link danger', type: 'button', onclick: guard(async () => { if (!confirm('Remove this price?')) return; await api(`/api/prices/${row.id}`, { method: 'DELETE' }); await showPrices(mine); }) }, 'Remove') : null))))
        : h('p', { class: 'muted' }, 'Nothing here yet. Scan something to add the first price.')));
  }

  // ── receipts ──────────────────────────────────────────────────────────────
  async function showReceipts() {
    const data = await api('/api/receipts');
    const store = storeSelect();
    const date = h('input', { type: 'date', value: state.today, max: state.today, required: true });
    const file = h('input', { type: 'file', accept: 'image/*', required: true });
    view.replaceChildren(
      h('form', { class: 'card', onsubmit: guard(async () => {
        const photo = file.files[0];
        if (!photo) throw new Error('Choose a photo of the receipt.');
        const saved = await api(`/api/receipts?storeId=${encodeURIComponent(store.value)}&date=${encodeURIComponent(date.value)}`, { method: 'POST', raw: photo, type: photo.type });
        toast(saved.attached ? `Receipt attached to ${saved.attached} price${saved.attached === 1 ? '' : 's'}` : 'Receipt saved. No prices matched that store and date yet.');
        await showReceipts();
      }) },
        h('h2', {}, 'Add a receipt'), h('p', { class: 'muted' }, 'A receipt backs up the prices you entered for that store on that day, so they can be confirmed. A screenshot of a digital receipt works too. For a single item, add a photo of the shelf price tag from the Prices tab instead.'),
        h('div', { class: 'row' }, field('Store', store), field('Date on the receipt', date)), field('Photo', file),
        h('button', { class: 'primary', type: 'submit' }, 'Upload receipt')),
      h('section', { class: 'card' }, h('h2', {}, state.user.role === 'admin' ? 'All receipts and price tags' : 'Your receipts and price tags'),
        data.receipts.length ? h('ul', { class: 'list' }, data.receipts.map((row) => h('li', {},
          h('span', {}, `${row.kind === 'tag' ? 'Price tag' : 'Receipt'} · ${row.purchasedOn} · ${storeLabel(row)}`, h('span', { class: 'muted' }, ` · ${row.priceCount} price${row.priceCount === 1 ? '' : 's'} · ${row.uploadedBy}`),
            row.status === 'verified' ? h('span', { class: 'tag verified' }, 'confirmed') : null),
          h('button', { class: 'link', type: 'button', onclick: guard(() => showReceipt(row.id)) }, 'Open'))))
          : h('p', { class: 'muted' }, 'No receipts yet.')));
  }

  async function showReceipt(id) {
    const data = await api(`/api/receipts/${id}`);
    const rejects = new Set();
    const isAdmin = state.user.role === 'admin';
    view.replaceChildren(
      h('section', { class: 'card' },
        h('button', { class: 'link', type: 'button', onclick: guard(showReceipts) }, 'Back to receipts'),
        h('h2', {}, `${data.receipt.kind === 'tag' ? 'Price tag' : 'Receipt'} · ${storeLabel(data.receipt)} · ${data.receipt.purchasedOn}`),
        data.receipt.aiCheckedAt ? h('p', { class: 'muted' }, `Read from the photo: ${data.receipt.aiPriceCents === null ? 'no price found' : money(data.receipt.aiPriceCents)}${data.receipt.aiName ? ` · ${data.receipt.aiName}` : ''}`) : null,
        h('img', { class: 'receipt-img', src: `/api/receipts/${id}/image`, alt: data.receipt.kind === 'tag' ? 'Price tag photo' : 'Receipt photo' })),
      h('section', { class: 'card' }, h('h2', {}, data.receipt.kind === 'tag' ? 'Price this photo backs up' : 'Prices on this receipt'),
        data.prices.length ? h('ul', { class: 'list' }, data.prices.map((row) => h('li', {},
          h('span', {}, h('strong', {}, row.name), h('span', { class: 'muted' }, ` ${[row.brand, row.size].filter(Boolean).join(' · ')}`), statusTag(row)),
          h('span', {}, h('span', { class: 'price' }, money(row.priceCents)),
            isAdmin && data.receipt.status !== 'verified' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (event) => { if (event.target.checked) rejects.add(row.id); else rejects.delete(row.id); } }), 'Wrong') : null))))
          : h('p', { class: 'muted' }, 'No prices are attached to this receipt.'),
        isAdmin && data.receipt.status !== 'verified' && data.prices.length ? h('button', { class: 'primary', type: 'button', onclick: guard(async () => {
          const done = await api(`/api/receipts/${id}/verify`, { method: 'POST', body: { rejectPriceIds: [...rejects] } });
          toast(`Confirmed ${done.verified}, removed ${done.rejected}`);
          await showReceipt(id);
        }) }, 'Confirm these prices (ticked ones are removed)') : null));
  }

  // ── stores ────────────────────────────────────────────────────────────────
  async function showStores() {
    await loadStores();
    const chain = h('select', { required: true }, state.chains.map((name) => h('option', { value: name }, name)));
    const suburb = h('input', { required: true, minlength: 2, placeholder: 'e.g. Chermside' });
    const region = h('select', { required: true }, state.states.map((name) => h('option', { value: name }, name)));
    region.value = localStorage.getItem('pb_state') || state.states[0];
    view.replaceChildren(
      h('form', { class: 'card', onsubmit: guard(async () => {
        const saved = await api('/api/stores', { method: 'POST', body: { chain: chain.value, suburb: suburb.value, state: region.value } });
        localStorage.setItem('pb_state', region.value); localStorage.setItem('pb_store', String(saved.store.id));
        toast('Store saved'); await showStores();
      }) }, h('h2', {}, 'Add a store'), h('div', { class: 'row' }, field('Chain', chain), field('State', region)), field('Suburb', suburb),
        h('button', { class: 'primary', type: 'submit' }, 'Save store')),
      h('section', { class: 'card' }, h('h2', {}, 'Stores'),
        state.stores.length ? h('ul', { class: 'list' }, state.stores.map((store) => h('li', {}, h('span', {}, storeLabel(store)), h('span', { class: 'muted' }, store.state))))
          : h('p', { class: 'muted' }, 'No stores yet. Add the ones you shop at.')));
  }

  // ── more ──────────────────────────────────────────────────────────────────
  async function showMore() {
    const nodes = [h('section', { class: 'card' }, h('h2', {}, state.user.displayName),
      h('p', { class: 'muted' }, 'Every price in the book can be downloaded as a spreadsheet. It contains no names.'),
      h('a', { href: '/api/export.csv' }, 'Download all prices (CSV)'),
      state.apkAvailable && !window.PricebookNative ? h('a', { href: '/pricebook.apk' }, 'Get the Android app') : null,
      h('button', { type: 'button', onclick: guard(async () => { await api('/api/logout', { method: 'POST' }); state.user = null; showAuth(); }) }, 'Sign out')),
    h('section', { class: 'card' }, h('h2', {}, 'Open by design'),
      h('p', { class: 'muted' }, 'Pricebook is free software under the AGPL-3.0 licence. The price data is open under the Open Database License (ODbL 1.0). Product names and pictures come from Open Food Facts.'),
      state.sourceUrl ? h('a', { href: state.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source code') : null,
      h('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', target: '_blank', rel: 'noopener noreferrer' }, 'Data licence (ODbL)'))];
    if (state.user.role === 'admin') {
      const [invites, users] = await Promise.all([api('/api/invites'), api('/api/users')]);
      nodes.push(h('section', { class: 'card' }, h('h2', {}, 'Invite someone'),
        h('p', { class: 'muted' }, 'Each code works once and lasts 14 days.'),
        h('button', { class: 'primary', type: 'button', onclick: guard(async () => { await api('/api/invites', { method: 'POST' }); await showMore(); }) }, 'Create an invite code'),
        invites.invites.length ? h('ul', { class: 'list' }, invites.invites.map((row) => h('li', {}, h('span', { class: 'code' }, row.code),
          h('span', { class: 'muted' }, row.usedBy ? `used by ${row.usedBy}` : row.expiresAt < Date.now() ? 'expired' : 'unused')))) : null));
      nodes.push(h('section', { class: 'card' }, h('h2', {}, 'People'), h('ul', { class: 'list' }, users.users.map((row) => h('li', {},
        h('span', {}, row.displayName, h('span', { class: 'muted' }, ` · ${row.username}${row.role === 'admin' ? ' · admin' : ''}`)), h('span', { class: 'muted' }, `${row.priceCount} prices`))))));
    }
    view.replaceChildren(...nodes);
  }

  const screens = { scan: showScan, prices: showPrices, receipts: showReceipts, stores: showStores, more: showMore };
  async function show(tab) {
    stopCamera();
    state.tab = tab;
    for (const button of tabs.querySelectorAll('button')) button.classList.toggle('active', button.dataset.tab === tab);
    try { await screens[tab](); } catch (error) { toast(error.message, true); }
  }
  tabs.addEventListener('click', (event) => { const button = event.target.closest('button[data-tab]'); if (button) show(button.dataset.tab); });

  async function enter() {
    who.textContent = state.user.displayName;
    tabs.hidden = false;
    await loadStores();
    await show(state.stores.length ? 'scan' : 'stores');
  }

  (async () => {
    try {
      const status = await api('/api/status');
      Object.assign(state, { chains: status.chains, states: status.states, today: status.today, user: status.user, apkAvailable: status.apkAvailable, sourceUrl: status.sourceUrl });
      if (state.user) await enter(); else showAuth(status.hasUsers);
    } catch (error) { view.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Pricebook is not reachable'), h('p', { class: 'muted' }, error.message))); }
  })();
})();
