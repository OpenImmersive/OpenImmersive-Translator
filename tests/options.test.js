/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Load options.html + options.js with the site's account answer mocked.
async function loadOptions({ stored = {}, auth } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const storage = { ...stored };
  global.chrome = {
    i18n: require('./i18n-stub').i18n,
    runtime: { sendMessage: jest.fn(async (m) => (typeof auth === 'function' ? auth(m) : auth)) },
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries(keys.filter(k => k in storage).map(k => [k, storage[k]]))),
        set: (items, cb) => { Object.assign(storage, items); cb && cb(); },
      },
    },
  };
  global.YLI18n = require('../i18n.js');
  global.YLLangs = require('../languages.js');
  global.YLFile = require('../file-translate.js');
  window.open = jest.fn();
  new Function(fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8'))();
  await new Promise(r => setTimeout(r, 0));
  return { storage };
}

afterEach(() => { jest.resetModules(); delete global.chrome; });

const signedIn = { success: true, available: true, user: { email: 'a@b.c', plan: 'free', credits: 100 } };

describe('options account card', () => {
  test('signed in on the free Google engine: offers the switch to Standard', async () => {
    await loadOptions({ auth: signedIn });
    expect(document.getElementById('oiAcctStatus').textContent).toContain('a@b.c');
    expect(document.getElementById('oiAcctNext').style.display).toBe('');
  });

  test('the switch sets the engine, saves it, and confirms in place', async () => {
    const { storage } = await loadOptions({ auth: signedIn });
    document.getElementById('btnOiUseStandard').click();
    await new Promise(r => setTimeout(r, 0));
    expect(storage.engine).toBe('oi-standard');
    expect(document.getElementById('defEngine').value).toBe('oi-standard');
    expect(document.getElementById('btnOiUseStandard').style.display).toBe('none');
    expect(document.getElementById('oiAcctNext').textContent).toContain('Standard');
  });

  test('already on an AI tier: no switch offered', async () => {
    await loadOptions({ auth: signedIn, stored: { engine: 'oi-premium' } });
    expect(document.getElementById('oiAcctNext').style.display).toBe('none');
  });

  test('signed out: no switch, and the login button opens the sign-in dialog', async () => {
    await loadOptions({ auth: { success: true, available: true, user: null } });
    expect(document.getElementById('oiAcctNext').style.display).toBe('none');
    expect(document.getElementById('oiAcctStatus').textContent).toContain('free');
    document.getElementById('btnOiLogin').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'oiLogin' });
  });
});

describe('options account card: signed-in and signed-out states', () => {
  const shown = (id) => document.getElementById(id).style.display !== 'none';

  test('signed in: shows the email and Sign out, not Log in / Sign up', async () => {
    await loadOptions({ auth: signedIn });
    expect(document.getElementById('oiAcctStatus').textContent).toContain('a@b.c');
    expect(shown('btnOiLogin')).toBe(false);
    expect(shown('btnOiLogout')).toBe(true);
    expect(document.getElementById('btnOiLogout').textContent).toBe('Sign out');
    expect(document.getElementById('oiAcctHint').textContent).toMatch(/Sign out here or on the website/);
  });

  test('signed out: Log in / Sign up, no Sign out, and the hint for getting an account', async () => {
    await loadOptions({ auth: { success: true, available: true, user: null } });
    expect(shown('btnOiLogin')).toBe(true);
    expect(shown('btnOiLogout')).toBe(false);
    expect(document.getElementById('oiAcctHint').textContent).not.toMatch(/Sign out/);
  });

  test('Sign out logs out on the site, then refreshes into the signed-out state', async () => {
    let user = signedIn.user;
    const calls = [];
    await loadOptions({
      auth: (m) => {
        calls.push(m.type);
        if (m.type === 'oiLogout') { user = null; return { success: true }; }
        return { success: true, available: true, user };
      },
    });
    document.getElementById('btnOiLogout').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toEqual(['oiAuthStatus', 'oiLogout', 'oiAuthStatus']);
    expect(document.getElementById('oiAcctStatus').textContent).not.toContain('a@b.c');
    expect(shown('btnOiLogin')).toBe(true);
    expect(shown('btnOiLogout')).toBe(false);
  });

  test('a failed sign-out says so and keeps the signed-in controls', async () => {
    await loadOptions({
      auth: (m) => (m.type === 'oiLogout' ? { success: false, error: 'The website API answered 500' } : signedIn),
    });
    document.getElementById('btnOiLogout').click();
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('oiAcctStatus').textContent).toBe('Could not sign out: The website API answered 500');
    expect(shown('btnOiLogout')).toBe(true);
  });
});
