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

export const mockLoginBodySchema = z
  .object({
    /** Select which mock identity to log in as; defaults to the first user. */
    userId: z.string().optional(),
  })
  .nullable()
  .optional();

export const mockMemberRoleSchema = z.enum(["admin", "editor", "viewer"]);

export const mockPrincipalSummarySchema = z
  .object({
    identityId: z.string(),
    username: z.string(),
    displayName: z.string(),
    email: z.string().email(),
    /** Declared role on the default workspace; null means non-member. */
    role: mockMemberRoleSchema.nullable(),
  })
  .readonly();

export const mockUsersResponseSchema = z.object({
  users: z.array(mockPrincipalSummarySchema),
});
