import { createContext, useContext, useState, type ReactNode } from 'react';
import { CollapsibleSection } from '../ds/index.ts';
import type { TaskSectionId } from './sections.ts';

/** Where task view sections read their first state and write each toggle. */
export interface TaskSections {
  get(id: TaskSectionId, fallback: boolean): boolean;
  set(id: TaskSectionId, open: boolean): void;
}

const SectionsContext = createContext<TaskSections>({
  get: (_, fallback) => fallback,
  set: () => undefined,
});

export const TaskSectionsProvider = SectionsContext.Provider;

/**
 * A task view section that starts in its stored state and stores each toggle. It reads once on
 * mount: a re-read of the task never opens or closes it.
 */
export function TaskSection({
  id,
  defaultOpen = true,
  title,
  count,
  summary,
  children,
}: {
  id: TaskSectionId;
  defaultOpen?: boolean;
  title: string;
  count?: number;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const sections = useContext(SectionsContext);
  const [initial] = useState(() => sections.get(id, defaultOpen));
  return (
    <CollapsibleSection
      title={title}
      count={count}
      summary={summary}
      defaultOpen={initial}
      onOpenChange={(open) => {
        sections.set(id, open);
      }}
    >
      {children}
    </CollapsibleSection>
  );
}
