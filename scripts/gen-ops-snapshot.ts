// Writes packages/contracts/ops.snapshot.json from the operation catalog. `version` is the hash
// of the rest of the file. The contracts tests fail when the committed file differs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { OPERATIONS } from '../packages/contracts/src/ops/catalog.ts';
import { catalogSnapshotBody, catalogVersion } from '../packages/contracts/src/ops/snapshot.ts';

const target = fileURLToPath(new URL('../packages/contracts/ops.snapshot.json', import.meta.url));
const body = catalogSnapshotBody(OPERATIONS);
const snapshot = { version: await catalogVersion(body), ...body };
const options = await resolveConfig(target);
const text = await format(JSON.stringify(snapshot), { ...options, parser: 'json' });
writeFileSync(target, text);
console.log(`wrote ${target}`);
