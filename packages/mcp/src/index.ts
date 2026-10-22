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
  MAILBOX_SERVER_NAMES,
} from "./servers";
export type { BuiltinServerOptions } from "./servers";
export {
  remoteServerConfig,
  remoteServerNames,
  remoteServerInfo,
  remoteServerReadOnly,
  remoteServerForwardsIdentity,
  isRemoteServer,
} from "./remote";
export type { RemoteServerInfo, RemoteDialOptions } from "./remote";
