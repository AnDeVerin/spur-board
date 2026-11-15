import { prSourceId, type Config, type PrEntityRef, type PrPoller } from '@spur-board/contracts';
import { CommandError } from './commands.ts';

/** Shared by explicit task reads and manual PR links; one deadline covers every distinct PR. */
export async function refreshPrs(
  config: Config,
  projectId: string,
  refs: readonly PrEntityRef[],
  poll: PrPoller['pollPr'] | undefined,
): Promise<void> {
  if (refs.length === 0) return;
  if (poll === undefined)
    throw new CommandError(
      'github_unavailable',
      'Wait until the GitHub source is running, then retry.',
    );
  const project = config.projects.find((entry) => entry.id === projectId);
  const unique = new Map(
    refs.map((ref) => [`${ref.repo.toLowerCase()}#${String(ref.number)}`, ref]),
  );
  const deadline = Date.now() + 10_000;
  for (const ref of unique.values()) {
    if (!project?.repos.some((repo) => repo.toLowerCase() === ref.repo.toLowerCase()))
      throw new CommandError(
        'github_unavailable',
        'Configure a GitHub source for the repository, then retry.',
      );
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0)
      throw new CommandError(
        'github_unavailable',
        'GitHub refresh timed out; retry the operation.',
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        poll(prSourceId(projectId, ref.repo), ref, { timeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new CommandError(
                'github_unavailable',
                'GitHub refresh timed out; retry the operation.',
              ),
            );
          }, timeoutMs);
        }),
      ]);
      if (!result.ok || result.value.status !== 'ok')
        throw new CommandError(
          'github_unavailable',
          'GitHub did not return current pull request facts; retry the operation.',
        );
    } catch (error) {
      if (error instanceof CommandError) throw error;
      const failure = new CommandError(
        'github_unavailable',
        'GitHub refresh failed; retry the operation.',
      );
      failure.cause = error;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}
