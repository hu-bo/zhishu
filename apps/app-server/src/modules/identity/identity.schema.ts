import { z } from "zod";

export const principalSchema = z.object({
  identityId: z.string(),
  tenantId: z.string().min(1).max(128),
  username: z.string(),
  displayName: z.string(),
  email: z.string().email(),
  globalRoles: z.array(z.string()).readonly(),
  active: z.boolean(),
});

export const mockLoginResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime(),
  user: principalSchema,
});
