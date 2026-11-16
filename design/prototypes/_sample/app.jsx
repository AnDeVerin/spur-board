// Sample prototype: mounts design system components from the kit as DS.<Name> and builds one
// missing part by hand, marked proposed. `pnpm ds:build` compiles this file into the kit.
const { useState } = DS.React;

const params = new URLSearchParams(location.search);
const state = params.get('state') === 'empty' ? 'empty' : 'default';
const initialTheme = params.get('theme') === 'light' ? 'light' : 'dark';

function applyTheme(preference) {
  const light =
    preference === 'light' ||
    (preference === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

// Proposed: a summary strip the design system does not have yet.
function ProposedSummary({ summary }) {
  return (
    <div className="proposed-summary" data-proposed="summary">
      <span className="proposed-label">proposed</span>
      <span>
        {summary.open} open · {summary.done} done
      </span>
    </div>
  );
}

function Sample({ fixture }) {
  const [preference, setPreference] = useState(initialTheme);
  const items = state === 'empty' ? [] : fixture.items;
  return (
    <main className="sample">
      <h1>{fixture.title}</h1>
      <ProposedSummary summary={state === 'empty' ? { open: 0, done: 0 } : fixture.summary} />
      {items.length === 0 ? (
        <p className="sample-empty" role="status">
          Empty state: no items
        </p>
      ) : (
        <ul className="sample-list">
          {items.map((item) => (
            <li className={`sample-item ${DS.quiet}`} key={item.key}>
              <span className="sample-key">{item.key}</span>
              <span className="sample-title">{item.title}</span>
              <DS.Chip tone={item.tone}>{item.label}</DS.Chip>
            </li>
          ))}
        </ul>
      )}
      {/* The theme menu opens upward, so the switch sits in a bottom bar, as in the app. */}
      <footer className="sample-footer">
        <DS.ThemeSwitch
          value={preference}
          onChange={(value) => {
            setPreference(value);
            applyTheme(value);
          }}
        />
      </footer>
    </main>
  );
}

applyTheme(initialTheme);
fetch('fixture.json')
  .then((response) => response.json())
  .then((fixture) => {
    DS.ReactDOM.createRoot(document.getElementById('root')).render(<Sample fixture={fixture} />);
  });
