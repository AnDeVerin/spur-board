import type { Rule } from 'eslint';

type BinaryExpression = Parameters<NonNullable<Rule.RuleListener['BinaryExpression']>>[0];
type CallExpression = Parameters<NonNullable<Rule.RuleListener['CallExpression']>>[0];
type Operand = BinaryExpression['left'] | CallExpression['arguments'][number] | null | undefined;

const PROJECT_NAMES = new Set(['project', 'projectId']);
const EQUALITY = new Set(['==', '===', '!=', '!==']);
const LOOKUPS = new Set(['includes', 'indexOf']);

// `project`, `projectId`, `task.project`, `task?.projectId`.
function isProject(operand: Operand): boolean {
  const node = operand?.type === 'ChainExpression' ? operand.expression : operand;
  if (node?.type === 'Identifier') return PROJECT_NAMES.has(node.name);
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    PROJECT_NAMES.has(node.property.name)
  );
}

// `'web'` or `` `web` `` without substitutions.
function isStringLiteral(operand: Operand): boolean {
  if (operand?.type === 'Literal') return typeof operand.value === 'string';
  return operand?.type === 'TemplateLiteral' && operand.expressions.length === 0;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow comparing a project id with a string literal' },
    schema: [],
    messages: {
      literal:
        'Do not compare a project id with a string literal. Read project-specific behaviour from the config.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        if (
          (isProject(node.left) && isStringLiteral(node.right)) ||
          (isProject(node.right) && isStringLiteral(node.left))
        )
          context.report({ node, messageId: 'literal' });
      },
      SwitchStatement(node) {
        if (!isProject(node.discriminant)) return;
        for (const switchCase of node.cases)
          if (isStringLiteral(switchCase.test))
            context.report({ node: switchCase, messageId: 'literal' });
      },
      // `['web'].includes(task.project)`, `['web', 'board'].indexOf(project)`.
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || !LOOKUPS.has(callee.property.name)) return;
        if (callee.object.type !== 'ArrayExpression') return;
        if (!callee.object.elements.every(isStringLiteral)) return;
        if (isProject(node.arguments[0])) context.report({ node, messageId: 'literal' });
      },
    };
  },
};

export default rule;
