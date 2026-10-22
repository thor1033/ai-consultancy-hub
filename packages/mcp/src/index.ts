export { connectMcpServers, isHttpConfig } from "./manager";
export type {
  McpStdioConfig,
  McpHttpConfig,
  McpServerConfig,
  ConnectedMcp,
} from "./manager";
export { builtinServerConfig, memoryServerConfig, BUILTIN_SERVER_NAMES } from "./servers";
export {
  remoteServerConfig,
  remoteServerNames,
  remoteServerInfo,
  isRemoteServer,
} from "./remote";
export type { RemoteServerInfo } from "./remote";
