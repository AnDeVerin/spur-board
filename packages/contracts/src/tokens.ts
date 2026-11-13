import { z } from 'zod';

/** Longest value each field of an operator token request takes, in characters. */
export const TOKEN_REQUEST_LIMITS = { name: 64, folder: 1024, host: 253 } as const;

/** Control, format and line or paragraph separator characters: they can disguise a prompt. */
const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

const tokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The body of `POST /v1/tokens/requests`: what the operator is asked to approve in Slack. */
export const tokenRequestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(TOKEN_REQUEST_LIMITS.name)
    .regex(/^[A-Za-z0-9._-]+$/),
  folder: z
    .string()
    .min(1)
    .max(TOKEN_REQUEST_LIMITS.folder)
    .regex(PLAIN_TEXT)
    .refine((value) => value.trim() !== ''),
  host: z.string().min(1).max(TOKEN_REQUEST_LIMITS.host).regex(PLAIN_TEXT),
  hash: tokenHashSchema,
});

/**
 * The short request hash the approval prompt and `board token create` both show, so the
 * operator can match the request they approve to the one they made.
 */
export function requestHashOf(hash: string): string {
  return hash.slice(0, 10);
}
