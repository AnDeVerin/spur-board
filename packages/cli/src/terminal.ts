/** Show control bytes as text so server data cannot change terminal state. */
export function escapeTerminalControls(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character;
  }).join('');
}
