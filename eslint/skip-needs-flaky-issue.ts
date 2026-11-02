import type { Rule } from 'eslint';

type MemberExpression = Parameters<NonNullable<Rule.RuleListener['MemberExpression']>>[0];
type Expression = MemberExpression['object'];

const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'suite', 'bench']);
const FLAKY_LINK = /\bflaky\b.*(#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;

// `it.skip`, `describe.skip.each(...)`, `test.concurrent.skip` -> the leftmost identifier.
function rootName(node: Expression): string | undefined {
  let current = node;
  for (;;) {
    if (current.type === 'MemberExpression') current = current.object;
    else if (current.type === 'CallExpression') current = current.callee;
    else if (current.type === 'TaggedTemplateExpression') current = current.tag;
    else return current.type === 'Identifier' ? current.name : undefined;
  }
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require a linked `flaky` issue next to every skipped test' },
    schema: [],
    messages: {
      unlinked:
        'Fix the test or delete it. To quarantine it, link an issue labelled `flaky` on the same line or the line above: `// flaky: #<issue>`.',
    },
  },
  create(context) {
    const comments = context.sourceCode.getAllComments();
    return {
      MemberExpression(node) {
        if (node.property.type !== 'Identifier' || node.property.name !== 'skip') return;
        if (!TEST_FUNCTIONS.has(rootName(node) ?? '')) return;
        const line = node.property.loc?.start.line;
        if (line === undefined) return;
        const linked = comments.some((comment) => {
          const end = comment.loc?.end.line;
          return (end === line || end === line - 1) && FLAKY_LINK.test(comment.value);
        });
        if (!linked) context.report({ node: node.property, messageId: 'unlinked' });
      },
    };
  },
};

export default rule;
