/* Minimal DOM stub so halloween.js can be exercised under node.
 * Not a browser — enough of one to assert on generated HTML and filter
 * results, which is where the bugs have actually been. */
import fs from 'fs';

export function mkEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', hidden: false, value: '',
    _cls: new Set(), _attr: {}, _q: {},
    classList: {
      toggle(c, on) { on ? el._cls.add(c) : el._cls.delete(c); return on; },
      add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); },
      contains(c) { return el._cls.has(c); },
    },
    setAttribute(k, v) { el._attr[k] = v; },
    getAttribute(k) { return el._attr[k] ?? null; },
    addEventListener() {},
    getBoundingClientRect() { return { height: el._h ?? 78 }; },
    querySelector(sel) { return (el._q[sel] ??= mkEl(id + sel)); },
  };
  return el;
}

export function boot({ at = null, events = null } = {}) {
  const made = {};
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const styleProps = {};
  globalThis.document = {
    readyState: 'complete',
    getElementById: (id) => (made[id] ??= mkEl(id)),
    querySelector: (sel) => ({ getBoundingClientRect: () => ({ height: 78 }) }),
    querySelectorAll: () => [],
    documentElement: {
      setAttribute() {}, removeAttribute() {},
      style: { setProperty(k, v) { styleProps[k] = v; } },
    },
    addEventListener() {},
    body: mkEl('body'),
  };
  globalThis.__styleProps = styleProps;
  globalThis.getComputedStyle = () => ({ position: 'sticky' });
  globalThis.window = { addEventListener() {}, scrollTo() {} };
  const data = events || JSON.parse(fs.readFileSync('halloween/events.json', 'utf8'));
  globalThis.fetch = async () => ({ ok: true, json: async () => data });

  if (at) {
    const Real = Date, fake = new Real(...at).getTime();
    globalThis.Date = class extends Real {
      constructor(...a) { if (!a.length) super(fake); else super(...a); }
      static now() { return fake; }
    };
  }

  const src = fs.readFileSync('halloween/halloween.js', 'utf8');
  eval(src.replace('})();',
    'globalThis.__t={state,groupByDay,orderedDays,renderCards,renderTable,' +
    'matches,buildPanels,render,today,dayLabel,timeKey};\n})();'));
  return { made, data, api: globalThis.__t };
}
