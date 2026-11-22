import { Fragment, useEffect, useRef, type RefObject } from 'react';
import {
  Icon,
  KeyValueBox,
  Meter,
  quiet,
  SidePanel,
  StatusDot,
  type KeyValueRow,
} from '../ds/index.ts';
import type { BoardSnapshot } from './data.ts';
import { formatDataTime } from './model.ts';
import {
  panelBoxes,
  scrollTarget,
  type PanelBox,
  type PanelRow,
  type ServiceName,
} from './services.ts';
import styles from './ServicesPanel.module.css';

/** A request to bring the box of a service into view; `seq` repeats a request for the same one. */
export interface ScrollRequest {
  service: ServiceName;
  seq: number;
}

function row(item: PanelRow): KeyValueRow {
  if ('note' in item) return { key: item.key };
  if ('status' in item) return { key: item.key, status: item.status };
  if ('meter' in item)
    return {
      key: item.key,
      value: (
        <>
          <Meter
            name={item.key}
            value={item.meter.value}
            limit={item.meter.limit}
            thresholds={item.meter.thresholds}
          />
          {item.text !== undefined && <span>{item.text}</span>}
        </>
      ),
    };
  return { key: item.key, value: item.text };
}

function Box({ box }: { box: PanelBox }) {
  const title = (
    <>
      <Icon name={box.icon} />
      {box.name}
      {box.health && (
        <span className={styles.state} data-tone={box.health.tone}>
          <StatusDot tone={box.health.tone} hollow={box.health.tone === 'unknown'} />
          {box.health.word}
        </span>
      )}
    </>
  );
  return (
    <section className={quiet} data-box={box.id} data-service={box.service ?? undefined}>
      <KeyValueBox title={title} rows={box.rows.map(row)} />
    </section>
  );
}

/** Consecutive boxes of one project, or the shared boxes when `project` is null. */
function runs(boxes: readonly PanelBox[]) {
  const out: { project: string | null; boxes: PanelBox[] }[] = [];
  for (const box of boxes) {
    const last = out.at(-1);
    if (last?.project === box.project) last.boxes.push(box);
    else out.push({ project: box.project, boxes: [box] });
  }
  return out;
}

/**
 * The services panel: a left SidePanel with the shared boxes (daemon, host, slack when a Slack
 * services row exists, spur), then one group per project headed by its id, all from the last good
 * `status.get`. A bar button scrolls to its service's worst box. `keepLive` is the status bar,
 * rendered before it.
 */
export function ServicesPanel({
  snapshot,
  open,
  onClose,
  scroll,
  keepLive,
}: {
  snapshot: BoardSnapshot;
  open: boolean;
  onClose: () => void;
  scroll: ScrollRequest | undefined;
  keepLive: RefObject<HTMLElement | null>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const boxes = panelBoxes(snapshot, formatDataTime);
  // Read at scroll time only: a refresh alone does not move the panel. Runs before the scroll.
  const order = (snapshot.status?.sources ?? []).map((source) => source.source);
  const latest = useRef({ boxes, order });
  useEffect(() => {
    latest.current = { boxes, order };
  });
  useEffect(() => {
    if (!open || scroll === undefined) return;
    const target = scrollTarget(latest.current.boxes, scroll.service, latest.current.order);
    if (target === undefined) return;
    list.current?.querySelector(`[data-box="${target}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, scroll]);
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      side="left"
      icon="pulse"
      title="Services"
      detail={
        // Only while live updates are lost and the daemon still answers, as the prototype.
        snapshot.stream === 'offline' && !snapshot.readFailed && snapshot.lastGoodAt !== undefined
          ? `Data from ${formatDataTime(snapshot.lastGoodAt)}`
          : undefined
      }
      keepLive={keepLive}
    >
      <div ref={list} className={styles.list}>
        {boxes.length === 0 ? (
          <p className={styles.note}>Waiting for the first status from the daemon.</p>
        ) : (
          runs(boxes).map(({ project, boxes: own }) => {
            const items = own.map((box) => <Box key={box.id} box={box} />);
            return project === null ? (
              <Fragment key="shared">{items}</Fragment>
            ) : (
              <section key={`project:${project}`} className={styles.group} aria-label={project}>
                <h2 className={styles.heading}>{project}</h2>
                <div className={styles.boxes}>{items}</div>
              </section>
            );
          })
        )}
      </div>
    </SidePanel>
  );
}
