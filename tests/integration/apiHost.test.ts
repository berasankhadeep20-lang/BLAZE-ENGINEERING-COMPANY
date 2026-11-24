import { describe, expect, it } from 'vitest';
import { createServices } from '../../src/application/composition';
import { openDatabase } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';
import { ApiHost, METHOD_NAMES, type HostHooks } from '../../src/main/apiHost';
import { fakeHasher } from '../helpers/auth';
import { MIGRATIONS_DIR } from '../helpers/fileWorld';

function makeHost(over: Partial<HostHooks> = {}): { host: ApiHost; logs: string[] } {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations(MIGRATIONS_DIR));
  const logs: string[] = [];
  const hooks: HostHooks = {
    appVersion: '9.9.9', log: (m) => logs.push(m), enterDemo: () => Promise.reject(new Error('no demo here')), exitDemo: () => undefined,
    chooseFolder: () => Promise.resolve(null), saveInvoicePdf: () => Promise.resolve({ saved: false }), ...over,
  };
  return { host: new ApiHost(createServices({ db, hasher: fakeHasher }), hooks), logs };
}
const setup = { username: 'owner', displayName: 'Shop Owner', password: 'owner-pass-1' };

describe('the door between the window and the program', () => {
  it('only knows the operations on its list; names like constructor or __proto__ are not operations', async () => {
    const { host } = makeHost();
    for (const m of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'auth.login.__proto__', '']) {
      expect(await host.invoke(m, [])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    expect(METHOD_NAMES).toContain('dashboard.get');
    expect(METHOD_NAMES.some((m) => m.includes('actorFor') || m.includes('sessions'))).toBe(false);
    expect(await host.invoke('app.state', 'not-an-array' as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('sets up the owner once, signs in, and the window never sees a token', async () => {
    const { host } = makeHost();
    expect(await host.invoke('app.state')).toMatchObject({ ok: true, data: { firstRun: true, mode: 'REAL', version: '9.9.9', user: null } });
    const made = await host.invoke('auth.firstRunSetup', [setup]);
    expect(made).toMatchObject({ ok: true });
    expect((made as { data: { recoveryCode: string } }).data.recoveryCode).toMatch(/^([A-Z2-9]{5}-){4}[A-Z2-9]{5}$/);
    expect(await host.invoke('auth.firstRunSetup', [setup])).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const login = await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(login).toMatchObject({ ok: true, data: { username: 'owner', role: 'OWNER' } });
    expect(JSON.stringify(login)).not.toMatch(/token/i);
    const state = await host.invoke('app.state');
    expect(JSON.stringify(state)).not.toMatch(/token/i);
    expect(state).toMatchObject({ data: { firstRun: false, user: { displayName: 'Shop Owner' } } });
    expect(await host.invoke('dashboard.get')).toMatchObject({ ok: true });
    expect(await host.invoke('items.list', [{ search: 'x' }])).toMatchObject({ ok: true, data: { rows: [], total: 0 } });
  });

  it('refuses everything that needs a session until someone has signed in, and again after sign-out', async () => {
    const { host } = makeHost();
    await host.invoke('auth.firstRunSetup', [setup]);
    for (const m of ['dashboard.get', 'items.list', 'customers.list', 'sales.list', 'settings.get', 'backup.status', 'backup.create', 'print.invoicePdf']) {
      expect(await host.invoke(m, [1]), m).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    }
    expect(await host.invoke('auth.login', ['owner', 'wrong-pass-1'])).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(await host.invoke('customers.list')).toMatchObject({ ok: true });
    await host.invoke('auth.logout');
    expect(await host.invoke('customers.list')).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    expect(await host.invoke('app.state')).toMatchObject({ data: { user: null } });
  });

  it('turns every failure into a plain message: known errors keep their code, surprises give no technical detail', async () => {
    const { host, logs } = makeHost({ chooseFolder: () => Promise.reject(new Error('C:\\secret\\path blew up')) });
    await host.invoke('auth.firstRunSetup', [setup]);
    await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(await host.invoke('auth.changePassword', ['owner-pass-1', 'short'])).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const boom = await host.invoke('backup.chooseFolder');
    expect(boom).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(boom)).not.toMatch(/secret|blew up|stack/i);
    expect(logs.join(' ')).toContain('backup.chooseFolder'); // but it is written to the log for whoever supports the program
  });

  it('demo mode swaps the services and session, and leaving puts the real ones back', async () => {
    const demo = makeHost();
    await demo.host.invoke('auth.firstRunSetup', [setup]);
    const demoServices = demo.host.realServices;
    const ownerToken = (await demoServices.auth.login('owner', 'owner-pass-1')).token;
    let exited = false;
    const { host } = makeHost({ enterDemo: () => Promise.resolve({ services: demoServices, ownerToken }), exitDemo: () => (exited = true) });
    expect(await host.invoke('demo.enter')).toMatchObject({ ok: true });
    expect(await host.invoke('app.state')).toMatchObject({ data: { mode: 'DEMO', user: { username: 'owner' } } });
    expect(await host.invoke('demo.exit')).toMatchObject({ ok: true });
    expect(exited).toBe(true);
    expect(await host.invoke('app.state')).toMatchObject({ data: { mode: 'REAL', user: null } });
  });
});
