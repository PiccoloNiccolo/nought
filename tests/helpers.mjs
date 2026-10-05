import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
export async function moduleAt(file, stubs = {}, globals = {}) {
  const timers = [];
  const context = vm.createContext({ console, URL, URLSearchParams, AbortSignal, AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {}, ...globals });
  const mod = new vm.SourceTextModule(await readFile(new URL('../' + file, import.meta.url), 'utf8'), { context });
  await mod.link((name) => {
    if (!(name in stubs)) throw new Error('Missing test dependency: ' + name);
    const exports = stubs[name];
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await mod.evaluate();
  return { api: mod.namespace, timers, context };
}
