import type { Config } from '@spur-board/contracts';
import { emit } from './board-utils.ts';
import { CommandError, type Mutation } from './commands.ts';
import { takenTurn, turnVisitTarget } from './turn-commands.ts';
import { endTurnWait, waitsUsed } from './turn-waits.ts';

/**
 * `task.wait`: the holder of a taken, open turn waits on an outside condition. An active wait is
 * replaced: it ends `closed` and its time counts. Past the turn's count or total time limit the
 * call is refused; otherwise the wait lasts `for` minutes, cut to the time left of the total, and
 * the turn's unsent reminders are dropped, so the board stays quiet until the tick wakes it.
 */
export function createTurnWaitMutation({ config }: { config: Config }): Mutation<'task.wait'> {
  return {
    id: 'task.wait',
    resolveTargets: (trx, input) => turnVisitTarget(trx, input.turn),
    async run(trx, input, ctx) {
      const { turn, task } = await takenTurn(trx, input.turn, ctx);
      const at = new Date(ctx.at);
      const waitedMs = await endTurnWait(trx, {
        turn,
        project: task.project,
        outcome: 'closed',
        at,
        actor: ctx.actor,
      });
      if (waitsUsed(config, { wait_count: turn.wait_count, waited_ms: waitedMs })) {
        throw new CommandError(
          'turn_wait_limit',
          `Turn ${input.turn} has used its waits; submit or return it.`,
        );
      }
      const left = config.health.turnWait.maxTotalMs - waitedMs;
      const until = new Date(at.getTime() + Math.min(input.for * 60_000, left)).toISOString();
      const waits = turn.wait_count + 1;
      await trx
        .updateTable('turn')
        .set({
          wait_reason: input.reason,
          wait_since: ctx.at,
          wait_until: until,
          wait_count: waits,
        })
        .where('id', '=', turn.id)
        .execute();
      await trx
        .updateTable('notification')
        .set({ acked_at: ctx.at })
        .where('turn_id', '=', turn.id)
        .where('kind', '=', 'turn_reminder')
        .where('acked_at', 'is', null)
        .where('exhausted_at', 'is', null)
        .execute();
      const payload = { turn: input.turn, reason: input.reason, until, waits };
      await emit(trx, 'turn_wait_started', task.project, task.id, ctx.at, payload, ctx.actor);
      return {
        turn: input.turn,
        wait: { reason: input.reason, since: ctx.at, wakesAt: until },
        waits,
      };
    },
  };
}
