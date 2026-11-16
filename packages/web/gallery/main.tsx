// The gallery: every example of every design system component, and the token table.
// Loads the design system first so tokens, component CSS and the quiet rules apply as real CSS.
import '../src/ds/index.ts';
import { StrictMode, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import tokensSource from '../src/ds/tokens.css?raw';
import styles from './Gallery.module.css';

type Theme = 'dark' | 'light';

const examples = import.meta.glob<Record<string, ComponentType>>('../src/ds/*/*.examples.tsx', {
  eager: true,
});
const components = Object.entries(examples)
  .map(([file, module]) => ({
    name: /\/([^/]+)\/[^/]+\.examples\.tsx$/.exec(file)?.[1] ?? file,
    examples: Object.entries(module),
  }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

function declarations(block: string): [string, string][] {
  return [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']);
}
const darkTokens = declarations(tokensSource.split(':root {')[1]?.split('}')[0] ?? '');
const lightTokens = new Map(
  declarations(tokensSource.split(":root[data-theme='light'] {")[1]?.split('}')[0] ?? ''),
);

function readTheme(): Theme {
  return new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}

// Grouping rule: colors get a swatch, spacing and sizes a bar, text sizes a sample, the rest
// show their value only.
function Preview({ name }: { name: string }) {
  if (name.startsWith('--color-'))
    return <span className={styles.swatch} style={{ background: `var(${name})` }} />;
  if (name.startsWith('--space-') || name.startsWith('--size-'))
    return <span className={styles.bar} style={{ width: `var(${name})` }} />;
  if (name.startsWith('--text-')) return <span style={{ fontSize: `var(${name})` }}>Sample</span>;
  return null;
}

function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <fieldset className={styles.themes}>
      <legend>Theme</legend>
      {(['dark', 'light'] as const).map((value) => (
        <label key={value} className={styles.radio}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            onChange={() => {
              onChange(value);
            }}
          />
          {value === 'dark' ? 'Dark' : 'Light'}
        </label>
      ))}
    </fieldset>
  );
}

function Gallery() {
  const [theme, setTheme] = useState(readTheme);
  // Examples render on the client, so the browser cannot scroll to a hash on load by itself.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);
  const change = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    const url = new URL(location.href);
    url.searchParams.set('theme', next);
    history.replaceState(null, '', url);
  };
  return (
    <main className={styles.page}>
      <h1>Design system</h1>
      <ThemePicker theme={theme} onChange={change} />
      {components.map((component) => (
        <section key={component.name}>
          <h2 id={component.name}>{component.name}</h2>
          {component.examples.map(([name, Example]) => (
            <article key={name}>
              <h3 id={`${component.name}-${name}`}>
                {component.name} / {name}
              </h3>
              <div className={styles.frame}>
                <Example />
              </div>
            </article>
          ))}
        </section>
      ))}
      <section>
        <h2 id="Tokens">Tokens</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Dark</th>
                <th scope="col">Light</th>
                <th scope="col">Preview</th>
              </tr>
            </thead>
            <tbody>
              {darkTokens.map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{value}</td>
                  <td>{lightTokens.get(name) ?? 'same'}</td>
                  <td>
                    <Preview name={name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

applyTheme(readTheme());
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
