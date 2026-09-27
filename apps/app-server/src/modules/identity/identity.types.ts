export type Principal = {
  identityId: string;
  tenantId: string;
  username: string;
  displayName: string;
  email: string;
  globalRoles: readonly string[];
  active: boolean;
};

export interface PrincipalAuthenticator {
  authenticate(authorization: string | undefined): Principal | null | Promise<Principal | null>;
}
