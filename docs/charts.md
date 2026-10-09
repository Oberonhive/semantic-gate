# Charts

`@semantic-gate/viz` turns *metadata + query + rows* into a complete ECharts
option. It decides from what the cube declares — dimension kinds, metric
additivity, modifier outputs, [display hints](cubes.md#visualization-hints)
— and never from a name. The gate itself never draws: inference runs where
JavaScript runs — the client, the CLI, the MCP server, the page.

- [How it decides](#how-it-decides)
- [Query hints](#query-hints)
- [The option](#the-option)

## How it decides

```text
shape    fields typed by dimension kind, additivity, modifier output,
         cardinality, label length, sign, the __rest__ row
rules    a first-match table picks the chart; each decision is recorded with its rule
encode   x, series, value axes, orientation, stack, sort, colours, marks, formats, zoom
option   JSON: rows in `dataset`, series bound by `encode`
```

| Situation | Chart |
|---|---|
| one row, no dimensions | KPI cards |
| a time dimension | line; `cumulative` → area; split by a second dimension with few members |
| a `share` over few members | pie |
| a geo dimension | world map (ISO 3166 codes) |
| an entity dimension and two metrics | scatter |
| two dense dimensions, one metric | heatmap |
| more than two dimensions, or two with several metrics | table |
| otherwise | bar — horizontal for many members or long labels |

How it draws:

- two units → two value axes (on a bar chart the second is a line);
- an additive metric split by series stacks; a non-additive one never does,
  even on request; a `share` split by series is a percent stack;
- `delta_*` outputs get a zero line and good/bad colours from `good_when`;
  `prev_value` is dashed, `rolling` smooth;
- `__rest__` comes last, in a neutral colour;
- declared member `order` and `colors` are kept, and a member keeps its
  colour across charts;
- a long time axis gets a zoom.

## Query hints

A query's `viz` pins any decision; inference makes the rest around it.

| Hint | |
|---|---|
| `chart` | `line area bar pie scatter heatmap map kpi table` |
| `x` | the column on the category or time axis |
| `series` | the column whose members split series |
| `y` | the measure columns to draw, in order (default: every metric column) |
| `stack` | `none \| stacked \| percent` |
| `orientation` | `vertical \| horizontal` |
| `title` | the chart title |
| `echarts` | a raw ECharts option merged last: objects by key, arrays by index |

```json
{"metrics": ["revenue"], "dimensions": ["period", "channel"],
 "viz": {"chart": "area", "series": "channel", "stack": "percent"}}
```

## The option

`chart()` — in the client, the CLI and MCP — returns
`{response, chart: {spec, option}}`. `spec` is the decided chart, and
`spec.reasons` says which rule made each decision. `option` is plain JSON, so
it can be stored or sent anywhere; formatters travel as `{"$format": …}`
references that `hydrate` turns into functions where the chart is drawn:

```ts
import * as echarts from 'echarts';
import { hydrate } from '@semantic-gate/viz';

echarts.init(element).setOption(hydrate(chart.option, 'en-US'));
```

A `table` is not drawn by ECharts: render `spec.columns` and the rows. A map
needs its geometry registered once — `echarts.registerMap(WORLD_MAP, geoJson)`
— as the [web example](../examples/web) does with ECharts 4.9's
`world.json`, fetched from a CDN.
