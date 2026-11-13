import { h, icon, btn, modal, toast, field, confirmDialog, resizeImage, badge } from '../ui.js';
import { inr, parseRupees, plain } from '../calc.js';
import { post, put, del } from '../api.js';
import { state, refreshMenu } from '../store.js';

export function mount(root) {
  let q = '';
  const listEl = h('div');
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Menu Management'),
      h('div', { class: 'row-gap' }, btn('Categories', { cls: 'ghost', onclick: categoriesModal }), btn('Add Item', { cls: 'primary', ic: 'plus', onclick: () => itemModal() }))),
    h('div', { class: 'searchbox wide' }, icon('search', 20), h('input', { type: 'search', placeholder: 'Search menu…', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } })),
    listEl,
    h('div', { class: 'card danger-zone' }, h('h3', null, 'Replace the sample menu'), h('p', { class: 'muted' }, 'The sample items are only examples. Edit them one by one, or remove all items and enter your own. Old bills are never changed.'),
      btn('Delete all items', { cls: 'danger', ic: 'trash', onclick: clearAll })));
  root.replaceChildren(page);

  async function run(fn, ok) { try { await fn(); await refreshMenu(); draw(); if (ok) toast(ok, 'ok'); } catch (e) { toast(e.message, 'error'); } }

  function draw() {
    const cats = state.categories;
    const groups = [...cats.map((c) => ({ c, items: state.items.filter((i) => i.category_id === c.id) })), { c: { id: null, name: 'No category', visible: 1 }, items: state.items.filter((i) => i.category_id == null) }];
    listEl.replaceChildren(...groups.map(({ c, items }) => {
      const its = items.filter((i) => !q || i.name.toLowerCase().includes(q));
      if (!its.length && (q || c.id == null)) return null;
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, c.name, c.visible ? null : badge('Hidden', 'warn')), h('span', { class: 'muted small' }, items.length + ' items')),
        its.length ? h('div', { class: 'list' }, its.map((it, idx) => itemRow(it, items, idx))) : h('div', { class: 'empty small' }, 'No items in this category.'));
    }));
  }

  // tap a thumbnail -> choose a photo (iPhone/Android: camera or gallery; computer: file picker) -> saved permanently on the server
  function pickPhoto(it) {
    const inp = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    inp.onchange = async () => {
      const f = inp.files[0]; inp.remove(); if (!f) return;
      toast('Uploading photo…', 'info');
      await run(async () => { const data = await resizeImage(f, 900); const r = await post('/api/upload', { data }); await put('/api/items/' + it.id, { image: r.url }); }, 'Photo saved');
    };
    document.body.append(inp); inp.click();
  }

  function itemRow(it, siblings, idx) {
    const move = (d) => {
      const all = state.items.map((i) => i.id); const a = all.indexOf(it.id), other = siblings[idx + d]; if (!other) return;
      const b = all.indexOf(other.id); [all[a], all[b]] = [all[b], all[a]];
      run(() => post('/api/items/reorder', { ids: all }));
    };
    return h('div', { class: 'mrow' + (it.available ? '' : ' dim') },
      h('button', { class: 'thumb-btn', type: 'button', title: 'Tap to add or change the photo', 'aria-label': 'Change photo of ' + it.name, onclick: () => pickPhoto(it) },
        it.image ? h('img', { class: 'thumb', src: it.image, alt: '' }) : h('div', { class: 'thumb ph' }, icon('menu', 26)), h('span', { class: 'thumb-edit' }, icon('upload', 14))),
      h('div', { class: 'mrow-main' }, h('b', null, it.name), h('div', { class: 'muted' }, inr(it.price)), !it.visible ? badge('Hidden', 'warn') : null),
      h('div', { class: 'mrow-tools' },
        h('button', { class: 'pill ' + (it.available ? 'good' : 'bad'), type: 'button', onclick: () => run(() => put('/api/items/' + it.id, { available: !it.available })) }, it.available ? 'Available' : 'Out of stock'),
        h('button', { class: 'icon-btn', type: 'button', title: it.visible ? 'Hide from billing' : 'Show in billing', 'aria-label': 'Toggle visibility', onclick: () => run(() => put('/api/items/' + it.id, { visible: !it.visible })) }, icon('eye', 20)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => move(-1) }, icon('up', 20)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move down', disabled: idx === siblings.length - 1, onclick: () => move(1) }, icon('down', 20)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit', onclick: () => itemModal(it) }, icon('edit', 20)),
        h('button', { class: 'icon-btn danger-text', type: 'button', 'aria-label': 'Delete', onclick: async () => { if (await confirmDialog(`Delete “${it.name}”? Old bills keep their record of it.`, { danger: true, okText: 'Delete' })) run(() => del('/api/items/' + it.id), 'Item deleted'); } }, icon('trash', 20))));
  }

  function itemModal(it) {
    let image = it?.image || '';
    const name = h('input', { type: 'text', maxlength: 80, value: it?.name || '', placeholder: 'e.g. Cheese Burger' });
    const price = h('input', { type: 'text', inputmode: 'decimal', value: it ? plain(it.price) : '', placeholder: '0.00' });
    const cat = h('select', null, h('option', { value: '' }, '— No category —'), state.categories.map((c) => h('option', { value: c.id, selected: it?.category_id === c.id }, c.name)));
    const avail = h('input', { type: 'checkbox', checked: it ? !!it.available : true });
    const vis = h('input', { type: 'checkbox', checked: it ? !!it.visible : true });
    const prev = h('div', { class: 'img-prev' });
    const drawPrev = () => prev.replaceChildren(image ? h('img', { src: image, alt: 'Item image' }) : h('div', { class: 'muted' }, 'No image'), image ? btn('Remove image', { cls: 'link danger-text', onclick: () => { image = ''; drawPrev(); } }) : null);
    drawPrev();
    const file = h('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const data = await resizeImage(f, 900); const r = await post('/api/upload', { data }); image = r.url; drawPrev(); } catch (err) { toast(err.message || 'Could not upload the image', 'error'); } } });
    const m = modal({ title: it ? 'Edit item' : 'Add item', body: h('div', null, field('Item name', name), field('Price (₹)', price), field('Category', cat), field('Food photo (camera or gallery)', file), prev,
        h('label', { class: 'check' }, avail, h('span', null, 'Available (untick = Out of Stock)')), h('label', { class: 'check' }, vis, h('span', null, 'Show in New Bill screen'))),
      actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Save', { cls: 'primary', onclick: async () => {
        const p = parseRupees(price.value);
        if (!name.value.trim()) return toast('Enter an item name', 'error');
        if (p == null) return toast('Enter a valid price, e.g. 120 or 99.50', 'error');
        const body = { name: name.value, price: p, category_id: cat.value ? Number(cat.value) : null, image, available: avail.checked, visible: vis.checked };
        await run(() => (it ? put('/api/items/' + it.id, body) : post('/api/items', body)), it ? 'Item updated - new bills use the new price' : 'Item added'); m.close(); } })] });
  }

  function categoriesModal() {
    const body = h('div');
    const redraw = () => {
      const cats = state.categories;
      const name = h('input', { type: 'text', maxlength: 40, placeholder: 'New category name' });
      body.replaceChildren(
        h('div', { class: 'list' }, cats.map((c, i) => h('div', { class: 'mrow' },
          h('div', { class: 'mrow-main' }, h('b', null, c.name), h('div', { class: 'muted small' }, state.items.filter((x) => x.category_id === c.id).length + ' items')),
          h('div', { class: 'mrow-tools' },
            h('button', { class: 'pill ' + (c.visible ? 'good' : 'bad'), type: 'button', onclick: () => act(() => put('/api/categories/' + c.id, { visible: !c.visible })) }, c.visible ? 'Visible' : 'Hidden'),
            h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { const ids = cats.map((x) => x.id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; act(() => post('/api/categories/reorder', { ids })); } }, icon('up', 20)),
            h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === cats.length - 1, onclick: () => { const ids = cats.map((x) => x.id); [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; act(() => post('/api/categories/reorder', { ids })); } }, icon('down', 20)),
            h('button', { class: 'icon-btn', 'aria-label': 'Rename', onclick: () => rename(c) }, icon('edit', 20)),
            h('button', { class: 'icon-btn danger-text', 'aria-label': 'Delete', onclick: () => act(() => del('/api/categories/' + c.id)) }, icon('trash', 20))))) ),
        h('div', { class: 'wa-row' }, name, btn('Add', { cls: 'primary', ic: 'plus', onclick: () => name.value.trim() && act(() => post('/api/categories', { name: name.value })) })));
    };
    async function act(fn) { try { await fn(); await refreshMenu(); redraw(); draw(); } catch (e) { toast(e.message, 'error'); } }
    function rename(c) {
      const inp = h('input', { type: 'text', value: c.name, maxlength: 40 });
      const mm = modal({ title: 'Rename category', body: field('Name', inp), actions: [btn('Cancel', { cls: 'ghost', onclick: () => mm.close() }), btn('Save', { cls: 'primary', onclick: async () => { await act(() => put('/api/categories/' + c.id, { name: inp.value })); mm.close(); } })] });
    }
    redraw();
    modal({ title: 'Categories', body, wide: true });
  }

  async function clearAll() {
    const t = h('input', { type: 'text', placeholder: 'DELETE ALL ITEMS' });
    const m = modal({ title: 'Delete all menu items?', body: h('div', null, h('p', null, 'This removes every menu item (categories stay). Old bills are not changed. Type ', h('b', null, 'DELETE ALL ITEMS'), ' to confirm.'), t),
      actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Delete all', { cls: 'danger', onclick: async () => { await run(() => post('/api/items/clear', { confirm: t.value }), 'All items deleted'); m.close(); } })] });
  }
  draw();
  return () => {};
}
