/* Shared by card.js and app.js: the icon set and the state from the URL. */
const STATE = new URLSearchParams(location.search).get('state') || '';

const I = {
  mark: '<path d="M8 1.5v13M2.4 4.75l11.2 6.5M13.6 4.75L2.4 11.25"/>',
  caret: '<path d="M4 6.5l4 4 4-4"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  inbox: '<path d="M2 9.5l2-6h8l2 6v3.5H2z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
  ticket: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.5"/>',
  pr: '<circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="12.5" r="1.7"/><path d="M4 5.2v5.6M12 10.8V7a2.5 2.5 0 0 0-2.5-2.5H8"/>',
  term: '<rect x="1.5" y="2.5" width="13" height="11"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3"/>',
  check: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.6"/>',
  merge:
    '<circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="6" r="1.7"/><path d="M4 5.2v5.6M12 7.7c0 2.3-3 2.3-8 2.6"/>',
  bubble: '<path d="M2 3h12v8H7.5L4.5 13.5V11H2z"/>',
  person: '<circle cx="8" cy="5" r="2.6"/><path d="M2.8 14c.6-3 2.6-4.3 5.2-4.3s4.6 1.3 5.2 4.3"/>',
  block: '<circle cx="8" cy="8" r="6"/><path d="M3.8 3.8l8.4 8.4"/>',
  back: '<path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  pulse: '<path d="M1.5 8.5h3l2-5 3 9 2-4h3"/>',
  shadow:
    '<path d="M8 2l6 3.2-6 3.2-6-3.2z"/><path d="M2 8.6l6 3.2 6-3.2" stroke-dasharray="1.6 1.6"/>',
  hash: '<path d="M6 2.5l-1.5 11M11.5 2.5l-1.5 11M2.5 6h11M2 10h11"/>',
  diamond: '<path d="M8 2l6 6-6 6-6-6z"/><path d="M8 5.5L10.5 8 8 10.5 5.5 8z"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/>',
  auto: '<circle cx="8" cy="8" r="6"/><path d="M8 2v12" /><path d="M8 4.5l3.5 3.5L8 11.5" />',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${I[n]}</svg>`;
