import { z } from 'zod';

/** Most installed spur-board files a reload request may list. */
export const SKILL_RELOAD_FILES_MAX = 64;

/** Most files a reload message names; more and it asks for every file. */
export const SKILL_RELOAD_NAMED_MAX = 6;

/** A spur-board skill file a reload message may name: `SKILL.md` or one `references/` page. */
export const skillReloadFileSchema = z
  .string()
  .regex(/^(?:SKILL\.md|references\/[a-z0-9][a-z0-9-]{0,63}\.md)$/);

/** Each installed spur-board file with the time its content last changed. */
export const skillReloadFilesSchema = z
  .record(skillReloadFileSchema, z.iso.datetime())
  .refine((files) => Object.keys(files).length <= SKILL_RELOAD_FILES_MAX, {
    message: `At most ${String(SKILL_RELOAD_FILES_MAX)} files.`,
  });
