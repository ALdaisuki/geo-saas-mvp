import { z } from "zod";

const sourceKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const allowedHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !value.includes("*"), "Research hosts must be explicit");

export const researchBoundsSchema = z.strictObject({
  maxBytes: z.number().int().min(1_024).max(5_000_000),
  robotsMaxBytes: z.number().int().min(1_024).max(1_000_000),
  timeoutMs: z.number().int().min(500).max(30_000),
  maxRedirects: z.number().int().min(0).max(5),
  maxDiscoveredUrls: z.number().int().min(1).max(1_000),
});

export const researchSourceCreateRequestSchema = z.strictObject({
  sourceKey: sourceKeySchema,
  displayName: z.string().trim().min(1).max(200),
  origin: z.string().trim().url().max(2_048),
  allowedHosts: z
    .array(allowedHostSchema)
    .min(1)
    .max(50)
    .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, {
      message: "Research hosts must be unique",
    }),
  userAgent: z.string().trim().min(8).max(256).refine((value) => !/[\r\n]/u.test(value)),
  bounds: researchBoundsSchema,
  respectRobots: z.literal(true).default(true),
});

export const researchSourceRetireRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const researchPageCaptureRequestSchema = z.strictObject({
  path: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine(
      (value) => value.startsWith("/") && !value.startsWith("//") && !value.includes("#"),
      "Capture path must be an origin-relative path without a fragment",
    ),
});

export const researchCaptureListQuerySchema = z.strictObject({
  sourcePolicyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ResearchSourceCreateRequest = z.infer<typeof researchSourceCreateRequestSchema>;
export type ResearchSourceRetireRequest = z.infer<typeof researchSourceRetireRequestSchema>;
export type ResearchPageCaptureRequest = z.infer<typeof researchPageCaptureRequestSchema>;
