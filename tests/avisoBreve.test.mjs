// components/AvisoBreve.tsx (fase 3 de Comprobaciones, incremento 2,
// 26-oct-2026): las dos píldoras (Pauta y Comprobaciones) nunca se enciman,
// aunque sus logros lleguen en la MISMA vuelta. React 18 junta los dos
// setState en un render y los efectos de las dos píldoras corren antes de
// pintar; aquí un React mínimo de mentira hace exactamente eso: renderiza
// las dos, corre los efectos de las dos y solo después vuelve a pintar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// --- Un React de mentira: hooks por instancia y efectos diferidos ---
const REACT = `
let cur = null;
export function useRef(v) {
  const i = cur, k = i.h++;
  if (!(k in i.s)) i.s[k] = { current: v };
  return i.s[k];
}
export function useState(v) {
  const i = cur, k = i.h++;
  if (!(k in i.s)) i.s[k] = { v: typeof v === 'function' ? v() : v };
  const slot = i.s[k];
  return [slot.v, (x) => {
    const n = typeof x === 'function' ? x(slot.v) : x;
    if (!Object.is(n, slot.v)) { slot.v = n; i.sucio = true; }
  }];
}
export function useEffect(fn, deps) {
  const i = cur, k = i.h++;
  const prev = i.s[k];
  const cambio = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, j) => !Object.is(d, prev.deps[j]));
  if (cambio) i.pend.push(() => { prev?.limpiar?.(); const c = fn(); i.s[k] = { deps, limpiar: typeof c === 'function' ? c : null }; });
}
export function __render(i, props) {
  cur = i; i.h = 0; i.pend = []; i.sucio = false;
  i.salida = i.C(props);
  cur = null;
}
export function __efectos(i) { const p = i.pend; i.pend = []; for (const f of p) f(); }
export function __desmontar(i) { for (const s of Object.values(i.s)) s?.limpiar?.(); }
`;
const JSX = `export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = 'f';`;

const { outputFiles } = await build({
  stdin: {
    contents: `export { default } from './src/components/AvisoBreve.tsx'; export * from 'react';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  jsx: 'automatic',
  plugins: [
    {
      name: 'react-de-mentira',
      setup(b) {
        b.onResolve({ filter: /^react(-dom)?(\/jsx-runtime)?$/ }, (a) => ({ path: a.path, namespace: 'sim' }));
        b.onLoad({ filter: /.*/, namespace: 'sim' }, (a) => ({
          contents:
            a.path === 'react'
              ? REACT
              : a.path === 'react/jsx-runtime'
                ? JSX
                : 'export const createPortal = (el) => el;',
          loader: 'js',
        }));
      },
    },
  ],
});
const M = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// Un DOM mínimo: nada en pantalla todavía (los setTexto no se han pintado).
globalThis.document = { querySelector: () => null, body: {}, visibilityState: 'visible' };
globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

const instancia = () => ({ C: M.default, s: {}, h: 0, pend: [], sucio: false, salida: null });
const props = (logros, mostrados) => ({
  logros,
  onMostrados: mostrados,
  porMostrar: (l) => l,
  texto: (l) => `✓ ${l.join(', ')}`,
});

test('logros de Pauta y Comprobaciones en la misma vuelta: una sola píldora a la vista; la otra espera', async () => {
  const pauta = instancia();
  const comp = instancia();
  const noop = () => {};
  const pp = props(['Toma de Tecate'], noop);
  const pc = props(['COL_551 · 2 fotos arriba'], noop);
  // Un solo render con los dos cambios (batching) y los efectos de las dos.
  M.__render(pauta, pp);
  M.__render(comp, pc);
  M.__efectos(pauta);
  M.__efectos(comp);
  // El siguiente render pinta lo que dejaron los setState.
  M.__render(pauta, pp);
  M.__render(comp, pc);
  const visibles = [pauta, comp].filter((i) => i.salida !== null);
  assert.equal(visibles.length, 1, 'no se enciman');
  assert.match(visibles[0].salida.props.children, /Tecate/);
  M.__efectos(pauta);
  M.__efectos(comp);
  // Al quitarla (un toque), la otra sale en su siguiente revisión.
  visibles[0].salida.props.onClick();
  M.__render(pauta, pp);
  M.__efectos(pauta);
  await new Promise((r) => setTimeout(r, 800));
  M.__render(comp, pc);
  M.__efectos(comp);
  assert.equal(pauta.salida, null);
  assert.ok(comp.salida, 'la de Comprobaciones salió después');
  assert.match(comp.salida.props.children, /COL_551/);
  M.__desmontar(pauta);
  M.__desmontar(comp);
});
