export { authenticate, legacyTokenCount, autoProvisionable, AUTO_PROVISION_ROLES } from "./principal";
export { accessProblem, isVendorEmail, vendorConfigured, isTemporary } from "./access";
export type { AccessFacts } from "./access";
export { userDirectory, setUserDirectory } from "./directory";
export type { UserDirectory, DirectoryUser } from "./directory";
export type { Principal, PrincipalSource } from "./principal";
export { authorize, rolesForAction, narrowRoles, actionsForRoles, ALL_ACTIONS } from "./policy";
export type { Action, PolicyEngine } from "./policy";
export { mintToken, isHubToken, tokenPrefix, hashToken, hashesEqual, TOKEN_SCHEME } from "./token";
export type { MintedToken } from "./token";
export {
  oauthConfig,
  mcpResource,
  verifyAccessToken,
  describeTokenFailure,
  looksLikeJwt,
} from "./oauth";
export type { OAuthConfig, OAuthIdentity } from "./oauth";
export { issueApiCredential, revokeApiCredential } from "./issue";
export type { IssuedCredential, IssueInput } from "./issue";
export { knowledgeAccessFor, defaultVisibility, ALL_KNOWLEDGE } from "./knowledge";
export type { KnowledgeAccess } from "./knowledge";
