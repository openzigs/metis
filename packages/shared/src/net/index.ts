/**
 * `@metis/shared/net` — canonical network helpers shared by every server
 * subsystem that opens an outbound socket. Issue #299 lifted the previously
 * triplicated `isPrivateIp` definitions into this module.
 */
export {
  classifyPrivateIp,
  isPrivateIp,
  isPrivateIPv4,
  isPrivateIPv6,
  isLoopbackHostname,
  type PrivateIpClass,
} from "./private-ip.js";
