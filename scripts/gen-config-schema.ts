// Writes packages/contracts/config.schema.json from the zod config schema.
// The contracts tests fail when the committed file differs from this output.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { configJsonSchema } from '../packages/contracts/src/config.ts';

const target = fileURLToPath(new URL('../packages/contracts/config.schema.json', import.meta.url));
const options = await resolveConfig(target);
const text = await format(JSON.stringify(configJsonSchema()), { ...options, parser: 'json' });
writeFileSync(target, text);
console.log(`wrote ${target}`);
