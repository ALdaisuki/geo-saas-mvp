import { z } from "zod";

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function boundedUnicodeString(minimum: number, maximum: number, label: string) {
  return z
    .string()
    .trim()
    .superRefine((value, context) => {
      const length = unicodeLength(value);
      if (length < minimum || length > maximum) {
        context.addIssue({
          code: "custom",
          message: `${label} must contain between ${minimum} and ${maximum} Unicode characters`,
        });
      }
    });
}

export const trendSourceKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const canonicalTrendUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
      );
    } catch {
      return false;
    }
  }, "Trend canonical URLs must be credential-free HTTPS URLs without fragments");

export const trendObservationRequestSchema = z.strictObject({
  sourceKey: trendSourceKeySchema,
  title: boundedUnicodeString(2, 300, "Trend title"),
  summary: boundedUnicodeString(1, 2_000, "Trend summary").optional(),
  canonicalUrl: canonicalTrendUrlSchema.optional(),
  sourceRank: z.number().int().min(1).max(1_000_000).optional(),
  heatValue: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  observedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const trendObservationIngestRequestSchema = z.strictObject({
  observations: z.array(trendObservationRequestSchema).min(1).max(100),
});

export const trendTopicCandidateListQuerySchema = z.strictObject({
  sourceKey: trendSourceKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  lookbackMinutes: z.coerce.number().int().min(15).max(43_200).default(10_080),
  includeExpired: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(false),
});

export type TrendObservationRequest = Readonly<z.infer<typeof trendObservationRequestSchema>>;
export type TrendObservationIngestRequest = Readonly<{
  observations: readonly TrendObservationRequest[];
}>;
export type TrendTopicCandidateListQuery = Readonly<
  z.infer<typeof trendTopicCandidateListQuerySchema>
>;
