// Small DOM helpers shared by the platform adapters (content/platforms/*.js).

const MT_DOM = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The first element matching any of the selectors, in order of preference.
  function first(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch {} // a selector this browser doesn't support
    }
    return null;
  }

  function all(selectors, root = document) {
    const out = new Set();
    for (const sel of selectors) {
      try { root.querySelectorAll(sel).forEach((el) => out.add(el)); } catch {}
    }
    return [...out];
  }

  const visible = (el) => !!el && el.getClientRects().length > 0;

  // What a person would read on a control: its label, or its text.
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
    .replace(/\s+/g, " ").trim();

  // A visible button or menu item whose label matches `re`.
  function control(re, root = document) {
    const sel = 'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="option"]';
    return [...root.querySelectorAll(sel)].find((el) => visible(el) && re.test(label(el))) || null;
  }

  // Clicks the control matching `re`, waiting up to `ms` for it to appear (e.g. in a menu).
  async function clickWhenShown(re, ms = 1500) {
    for (let waited = 0; waited <= ms; waited += 150) {
      const el = control(re);
      if (el) { el.click(); return true; }
      await sleep(150);
    }
    return false;
  }

  const closeMenus = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  // A display name from a label like "Jane Doe (You)", "Jane Doe, Organizer" or "Jane Doe\nMuted".
  const cleanName = (s) => (s || "").split("\n")[0].replace(/\s*\((you|me|host|guest|organi[sz]er|external)\)\s*/gi, " ")
    .replace(/,\s*(organi[sz]er|presenter|attendee|host|co-host).*$/i, "").replace(/\s+/g, " ").trim();

  return { sleep, first, all, visible, label, control, clickWhenShown, closeMenus, cleanName };
})();
