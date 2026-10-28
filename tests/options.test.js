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
    runtime: { sendMessage: jest.fn(async () => auth) },
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
    expect(window.open).toHaveBeenCalledWith('https://openimmersive.ai/?login=1', '_blank');
  });
});
