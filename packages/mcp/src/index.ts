export { connectMcpServers, isHttpConfig } from "./manager";
export type {
  McpStdioConfig,
  McpHttpConfig,
  McpServerConfig,
  ConnectedMcp,
  McpToolInfo,
} from "./manager";
export {
  builtinServerConfig,
  builtinOptionsFrom,
  memoryServerConfig,
  BUILTIN_SERVER_NAMES,
  BUILTIN_SERVER_INFO,
  MAILBOX_SERVER_NAMES,
} from "./servers";
export type { BuiltinServerOptions } from "./servers";
export {
  remoteServerConfig,
  remoteServerNames,
  remoteServerInfo,
  remoteConfigError,
  remoteServerReadOnly,
  remoteServerForwardsIdentity,
  isRemoteServer,
  isEnvRemoteServer,
  setHubRemoteServers,
  hubRemoteProblem,
} from "./remote";
export type { RemoteServerInfo, RemoteDialOptions, HubRemoteServer } from "./remote";
