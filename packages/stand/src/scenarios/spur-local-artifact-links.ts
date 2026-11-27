import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const ARTIFACT_SESSION = 'artifact-session';
const OTHER_SESSION = 'other-session';
const ARTIFACT_WEB_LINK = { label: 'preview', url: 'https://example.com/preview' };
const OTHER_WEB_LINK = { label: 'tracker', url: 'https://example.com/task' };

export const spurLocalArtifactLinks: Scenario = {
  name: 'spur-local-artifact-links',
  summary: 'Spur polls keep both sessions when one publishes a local artifact link.',
  async seed(board, fakes) {
    await fakes.spur('session', {
      id: ARTIFACT_SESSION,
      links: [{ label: 'report', url: 'file:///example/report.html' }, ARTIFACT_WEB_LINK],
    });
    await fakes.spur('session', { id: OTHER_SESSION, links: [OTHER_WEB_LINK] });
    const outcomes = await board.poll();
    if (outcomes['spur'] !== 'delivered')
      throw new Error(
        `The Spur poll with a local artifact link was ${outcomes['spur'] ?? 'missing'}.`,
      );
    return { sessions: { artifact: ARTIFACT_SESSION, other: OTHER_SESSION } };
  },
  async settled({ board }) {
    const { unlinkedSessions } = await board.call('operator', 'status.get', { detail: true });
    const expected = [
      { id: ARTIFACT_SESSION, link: ARTIFACT_WEB_LINK },
      { id: OTHER_SESSION, link: OTHER_WEB_LINK },
    ];
    return settledUnless(
      expected.flatMap(({ id, link }) => {
        const session = unlinkedSessions.find((row) => row.id === id);
        const [published] = session?.links ?? [];
        return session?.state === 'live' &&
          session.links?.length === 1 &&
          published?.label === link.label &&
          published.url === link.url
          ? []
          : [`Expected live session ${id} with only its web link`];
      }),
    );
  },
};
