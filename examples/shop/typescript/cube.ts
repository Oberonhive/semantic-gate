import {
  CONTRACT_VERSION,
  Refusal,
  defineProvider,
  type Column,
  type DimensionDecl,
  type Filter,
  type Json,
  type MetricDecl,
  type Metadata,
  type SemanticQuery,
  type TimeGrain,
} from '@semantic-gate/contract';

const GRAINS: TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

const timeParams = {
  type: 'object',
  properties: { time_grain: { type: 'string', enum: GRAINS, default: 'month' } },
} as const;

const metrics: (MetricDecl & { sql: string })[] = [
  {
    name: 'revenue', sql: 'sum(o.revenue)', description: 'Gross order revenue.', value_type: 'number',
    additivity: 'additive', dimensions: ['period', 'region', 'channel', 'category'],
    display: { label: 'Revenue', unit: 'USD', format: 'currency', good_when: 'up' },
  },
  {
    name: 'orders', sql: 'count(*)', description: 'Number of orders.', value_type: 'integer',
    additivity: 'additive', dimensions: ['period', 'region', 'channel', 'category'],
    display: { label: 'Orders', format: 'number', decimals: 0, good_when: 'up' },
  },
  {
    name: 'aov', sql: 'sum(o.revenue) / nullif(count(*), 0)', description: 'Average order value.', value_type: 'number',
    additivity: 'non_reaggregable', dimensions: ['period', 'region', 'channel', 'category'],
    display: { label: 'Average order value', unit: 'USD', format: 'currency', good_when: 'up' },
  },
];

const dimensions: (DimensionDecl & { sql: string })[] = [
  {
    name: 'period', sql: 'o.order_date', description: 'Order date, truncated to the `time_grain` parameter (default month).',
    kind: 'time', value_type: 'date', grains: GRAINS, params: timeParams, display: { label: 'Period' },
  },
  {
    name: 'region', sql: 'o.region', description: 'Sales region.', kind: 'category', value_type: 'string',
    display: { label: 'Region', order: ['EU', 'North America', 'APAC', 'LATAM'] },
  },
  {
    name: 'channel', sql: 'o.channel', description: 'Sales channel.', kind: 'category', value_type: 'string',
    display: { label: 'Channel', colors: { web: '#4e79a7', app: '#f28e2b', retail: '#59a14f', partner: '#b07aa1' } },
  },
  {
    name: 'category', sql: 'o.category', description: 'Product category.', kind: 'category', value_type: 'string',
    display: { label: 'Category' },
  },
];

const strip = <T extends { sql: string }>({ sql: _sql, ...decl }: T) => decl;

const metadata: Metadata = {
  contract_version: CONTRACT_VERSION,
  cubes_sha: 'shop-typescript-1',
  metrics: metrics.map(strip),
  dimensions: dimensions.map(strip),
  modifiers: [],
};

const lit = (v: Json): string => {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Refusal('invalid_params', `unsupported filter value ${JSON.stringify(v)}`);
};

/** `time_grain` or `period.time_grain`; the more specific key wins. */
function grainOf(query: SemanticQuery): TimeGrain {
  for (const key of Object.keys(query.params ?? {})) {
    if (key !== 'time_grain' && key !== 'period.time_grain') {
      throw new Refusal('invalid_params', `unknown parameter \`${key}\``, 'declared: time_grain');
    }
  }
  const v = query.params?.['period.time_grain'] ?? query.params?.time_grain ?? 'month';
  if (!GRAINS.includes(v as TimeGrain)) {
    throw new Refusal('invalid_params', `time_grain must be one of ${GRAINS.join(', ')}`);
  }
  return v as TimeGrain;
}

export default defineProvider({
  initialize: () => ({ contract_version: CONTRACT_VERSION, dialects: ['duckdb'] }),
  metadata: () => metadata,
  plan({ query }) {
    const grain = grainOf(query);
    const dimSql = (name: string) => {
      const d = dimensions.find((x) => x.name === name);
      if (!d) throw new Refusal('unknown_dimension', `unknown dimension \`${name}\``, `declared: ${dimensions.map((x) => x.name).join(', ')}`);
      return d.name === 'period' ? `date_trunc('${grain}', ${d.sql})::date` : d.sql;
    };

    if (query.modifiers?.length) {
      throw new Refusal('unknown_modifier', `unknown modifier \`${query.modifiers[0]!.name}\``, 'this cube declares no modifiers');
    }
    const ms = query.metrics.map((name) => {
      const m = metrics.find((x) => x.name === name);
      if (!m) throw new Refusal('unknown_metric', `unknown metric \`${name}\``, `declared: ${metrics.map((x) => x.name).join(', ')}`);
      return m;
    });
    const dims = query.dimensions ?? [];
    for (const d of dims) dimSql(d);
    for (const m of ms) {
      const bad = dims.find((d) => !m.dimensions.includes(d));
      if (bad) throw new Refusal('invalid_composition', `metric \`${m.name}\` cannot be cut by \`${bad}\``);
    }

    const where = (f: Filter): string => {
      if ('items' in f) {
        if (f.op === 'not') return `not (${where(f.items[0]!)})`;
        return `(${f.items.map(where).join(f.op === 'and' ? ' and ' : ' or ')})`;
      }
      if (metrics.some((m) => m.name === f.field)) {
        throw new Refusal('invalid_composition', 'this cube filters on dimensions only');
      }
      const col = dimSql(f.field);
      const v = f.value;
      switch (f.op) {
        case '=': case '!=': case '>=': case '<=':
          return `${col} ${f.op === '!=' ? '<>' : f.op} ${lit(v!)}`;
        case 'in': case 'between': {
          if (!Array.isArray(v) || (f.op === 'between' && v.length !== 2)) {
            throw new Refusal('invalid_params', `\`${f.op}\` takes ${f.op === 'between' ? 'a [low, high] pair' : 'an array'}`);
          }
          return f.op === 'in' ? `${col} in (${v.map(lit).join(', ')})` : `${col} between ${lit(v[0]!)} and ${lit(v[1]!)}`;
        }
        default:
          throw new Refusal('filter_op_not_allowed', `operator \`${f.op}\` is not allowed here`, 'allowed: = != in between >= <=');
      }
    };

    const columns: Column[] = [
      ...dims.map((name): Column => {
        const d = dimensions.find((x) => x.name === name)!;
        return { name, role: 'dimension', member: name, value_type: d.value_type, ...(name === 'period' && { grain }) };
      }),
      ...ms.map((m): Column => ({ name: m.name, role: 'metric', member: m.name, value_type: m.value_type })),
    ];
    const order = (query.order ?? dims.map((field) => ({ field, dir: 'asc' as const }))).map((o) => {
      if (!columns.some((c) => c.name === o.field)) throw new Refusal('invalid_params', `cannot order by \`${o.field}\`: not in the result`);
      return `"${o.field}" ${o.dir}`;
    });

    const select = [...dims.map((d) => `${dimSql(d)} as "${d}"`), ...ms.map((m) => `${m.sql} as "${m.name}"`)];
    const sql = [
      `select ${select.join(', ')}`,
      'from orders o',
      query.filters ? `where ${where(query.filters)}` : '',
      dims.length ? `group by ${dims.map((_, i) => i + 1).join(', ')}` : '',
      order.length ? `order by ${order.join(', ')}` : '',
      query.limit !== undefined ? `limit ${Math.trunc(query.limit)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { sql, columns };
  },
});
