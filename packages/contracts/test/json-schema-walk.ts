// Walks a JSON Schema produced by `z.toJSONSchema` and collects its properties.

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Walked {
  /** Properties without a description. */
  undescribed: string[];
  /** Nodes with `properties` that allow extra keys. */
  open: string[];
  /** Object nodes without `properties`: opaque payloads. Not descended into. */
  opaque: string[];
  properties: { path: string; name: string; node: JsonObject }[];
}

export function walk(node: unknown, path = '', out: Walked = emptyWalk()): Walked {
  if (!isObject(node)) return out;
  if (isObject(node['properties'])) {
    if (node['additionalProperties'] !== false) out.open.push(path);
    for (const [name, child] of Object.entries(node['properties'])) {
      const childPath = `${path}.${name}`;
      if (!isObject(child)) continue;
      if (typeof child['description'] !== 'string' || child['description'] === '') {
        out.undescribed.push(childPath);
      }
      out.properties.push({ path: childPath, name, node: child });
      walk(child, childPath, out);
    }
  } else if (node['type'] === 'object') {
    out.opaque.push(path);
    return out;
  }
  walk(node['items'], `${path}[]`, out);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const branches = node[key];
    if (Array.isArray(branches))
      branches.forEach((branch, i) => walk(branch, `${path}|${String(i)}`, out));
  }
  return out;
}

function emptyWalk(): Walked {
  return { undescribed: [], open: [], opaque: [], properties: [] };
}
