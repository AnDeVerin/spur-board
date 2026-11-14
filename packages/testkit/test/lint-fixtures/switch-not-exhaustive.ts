type Kind = 'a' | 'b';

// A default does not count as covering 'b': a new member must be listed.
export function label(kind: Kind): string {
  switch (kind) {
    case 'a':
      return 'A';
    default:
      return 'other';
  }
}
