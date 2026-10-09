/**
 * The browser host: no server in the loop. Local mode loads a cube directory
 * with `@semantic-gate/semtrans`, runs its SQL on DuckDB-wasm and draws the
 * option `@semantic-gate/viz` inferred; remote mode talks REST to a gate
 * (which must answer CORS for this origin).
 */
import * as echarts from 'echarts';
import {
  createClient,
  GateError,
  httpTransport,
  loadCubes,
  localTransport,
  type Client,
} from '@semantic-gate/client';
import { duckdbWasm, fetchReader } from '@semantic-gate/client/browser';
import type { SemanticQuery } from '@semantic-gate/contract';
import { formatter, hydrate, WORLD_MAP, type Chart, type TableColumn } from '@semantic-gate/viz';

const QUERIES = [
  '01-revenue-trend', '02-revenue-by-region', '03-top-categories', '04-growth-by-region',
  '05-channel-share', '06-kpis', '07-revenue-by-country', '08-weekly-orders-rolling',
  '09-channel-mix-stacked', '10-segment-margin', '11-customer-scatter', '12-cumulative-revenue',
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mode = () => (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
const locale = navigator.language || 'en-US';
const params = new URLSearchParams(location.search);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

const clients = new Map<string, Promise<Client>>();
function clientFor(): Promise<Client> {
  const key = mode() === 'local' ? `local:${$<HTMLInputElement>('cubes').value}` : `remote:${$<HTMLInputElement>('gate').value}:${$<HTMLInputElement>('ns').value}`;
  let client = clients.get(key);
  if (!client) {
    client =
      mode() === 'local'
        ? (async () => {
            const rules = { read: (path: string) => fetchReader.read(`/packages/semtrans/rules/${path}`) };
            const { provider, manifest, dir } = await loadCubes($<HTMLInputElement>('cubes').value, fetchReader, { rules });
            const engine = await duckdbWasm(manifest.tables, dir, { dist: '/node_modules/@duckdb/duckdb-wasm/dist/' });
            return createClient(localTransport({ provider, engine }));
          })()
        : Promise.resolve(
            createClient(
              httpTransport({
                gate: $<HTMLInputElement>('gate').value,
                namespace: $<HTMLInputElement>('ns').value,
                ...($<HTMLInputElement>('token').value && { token: $<HTMLInputElement>('token').value }),
              }),
            ),
          );
    clients.set(key, client);
    client.catch(() => clients.delete(key));
  }
  return client;
}

let mapReady: Promise<void> | undefined;
// Apache ECharts 4.9's world map (Apache-2.0), fetched rather than copied into this repository.
const registerWorld = () =>
  (mapReady ??= fetch('https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json')
    .then((r) => r.json())
    .then((geo) => void echarts.registerMap(WORLD_MAP, geo)));

const chartEl = $('chart');
let instance: echarts.ECharts | undefined;
const status = (text: string, error = false) => {
  $('status').textContent = text;
  $('status').className = error ? 'err' : '';
};

function renderTable(columns: TableColumn[], option: Chart['option']) {
  const [{ dimensions, source }] = option.dataset as [{ dimensions: string[]; source: unknown[][] }];
  const cols = columns.map((c) => ({ ...c, index: dimensions.indexOf(c.field), fmt: c.format ? formatter(c.format, locale) : String }));
  const el = $('table');
  const cell = (tag: string, text: string) => `<${tag}>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${tag}>`;
  el.innerHTML =
    `<table><thead><tr>${cols.map((c) => cell('th', c.label)).join('')}</tr></thead><tbody>` +
    source.map((r) => `<tr>${cols.map((c) => cell('td', r[c.index] == null ? '—' : c.fmt(r[c.index]))).join('')}</tr>`).join('') +
    '</tbody></table>';
}

async function draw(chart: Chart) {
  const isTable = chart.spec.kind === 'table';
  chartEl.hidden = isTable;
  $('table').hidden = !isTable;
  if (isTable) return renderTable(chart.spec.columns ?? [], chart.option);
  if (chart.spec.kind === 'map') await registerWorld();
  instance ??= echarts.init(chartEl);
  instance.setOption({ ...hydrate(chart.option, locale), ...(params.get('animation') === '0' && { animation: false }) }, true);
  instance.resize();
}

async function run() {
  status('running…');
  $('reasons').innerHTML = '';
  let query: SemanticQuery;
  try {
    query = JSON.parse($<HTMLTextAreaElement>('query').value) as SemanticQuery;
  } catch (e) {
    return status(`query is not JSON: ${(e as Error).message}`, true);
  }
  try {
    const client = await clientFor();
    const t0 = performance.now();
    const { response, chart } = await client.chart(query, dark ? { text: '#e6e7ea', muted: '#9097a1' } : undefined);
    await draw(chart);
    status(`${chart.spec.kind} · ${response.rows.length} rows · ${Math.round(performance.now() - t0)} ms`);
    $('reasons').innerHTML = chart.spec.reasons
      .map((r) => `<li>${r.decision} <span>${r.rule}</span></li>`)
      .join('');
      } catch (e) {
    const envelope = e instanceof GateError ? e.envelope : { code: 'internal', message: (e as Error).message };
    status(`${envelope.code}: ${envelope.message}`, true);
  }
}

async function select(name: string, button: HTMLElement) {
  document.querySelectorAll('#queries button').forEach((b) => b.classList.remove('on'));
  button.classList.add('on');
  $<HTMLTextAreaElement>('query').value = await (await fetch(`/examples/shop/queries/${name}.json`)).text();
  await run();
}

for (const name of QUERIES) {
  const b = document.createElement('button');
  b.textContent = name.replace(/^\d+-/, '').replace(/-/g, ' ');
  b.onclick = () => void select(name, b);
  $('queries').append(b);
}
const syncMode = () => {
  $('local').hidden = mode() !== 'local';
  $('remote').hidden = mode() !== 'remote';
};
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
$('run').onclick = () => void run();
window.addEventListener('resize', () => instance?.resize());

// `?mode=remote&gate=URL&ns=NAME&q=3` (or `cubes=DIR`) preselects a source and runs the nth example: a link to a chart.
if (params.get('mode') === 'remote') {
  $<HTMLInputElement>('remote-mode').click();
  syncMode();
}
for (const key of ['gate', 'ns', 'cubes'] as const) {
  const v = params.get(key);
  if (v) $<HTMLInputElement>(key).value = v;
}
const nth = Number(params.get('q'));
if (params.has('q') && QUERIES[nth - 1]) document.querySelectorAll<HTMLElement>('#queries button')[nth - 1]?.click();
