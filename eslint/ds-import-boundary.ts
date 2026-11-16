import type { Rule } from 'eslint';
import { dirname, resolve, sep } from 'node:path';

const dsRoot = resolve(import.meta.dirname, '../packages/web/src/ds');
const dsIndex = resolve(dsRoot, 'index.ts');
const insideDs = (target: string) => target === dsRoot || target.startsWith(`${dsRoot}${sep}`);

type ImportNode = { source?: unknown; argument?: unknown };

// The string literal an import, export, `import()` or `import('x').T` names, if any.
function specifierOf(node: ImportNode): { node: Rule.Node; value: string } | undefined {
  const source = (node.source ?? node.argument) as { type?: string; value?: unknown } | null;
  if (source?.type !== 'Literal' || typeof source.value !== 'string') return undefined;
  return { node: source as Rule.Node, value: source.value };
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Keep packages/web/src/ds self-contained and reached only through ds/index.ts',
    },
    schema: [],
    messages: {
      inside:
        'Design system files import only their own ds/ files and browser packages, never app code or @spur-board/*.',
      outside: 'Web code imports the design system only through ds/index.ts.',
    },
  },
  create(context) {
    const fromDs = insideDs(context.filename);
    const check = (node: ImportNode) => {
      const source = specifierOf(node);
      if (!source) return;
      // `tokens.css?raw` is tokens.css, `index.ts?raw` is index.ts.
      const specifier = source.value.replace(/\?.*$/, '');
      const relative = specifier.startsWith('.');
      const target = relative ? resolve(dirname(context.filename), specifier) : undefined;
      if (fromDs) {
        const leaves = target !== undefined && !insideDs(target);
        if (leaves || specifier.startsWith('@spur-board/'))
          context.report({ node: source.node, messageId: 'inside' });
      } else if (target !== undefined && insideDs(target) && target !== dsIndex) {
        context.report({ node: source.node, messageId: 'outside' });
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      // TSImportType is not in the ESTree listener types; the parser still emits it.
      ...({ TSImportType: check } as Rule.RuleListener),
    };
  },
};

export default rule;
