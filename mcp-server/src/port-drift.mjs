import net from 'node:net';

// 历史上出现过“配置使用 8787、旧进程监听 8878”的端口漂移，导致客户端反复连接到已废弃端口。
export const HISTORICAL_DRIFT_PORTS = Object.freeze([8878]);
export const DEFAULT_MCP_PORT = 8787;

/**
 * 探测 host:port 是否有进程正在监听。
 * 仅做一次短超时 TCP 连接探测，不发送任何数据，不读取任何内容。
 */
export function detectPortDrift({ host = '127.0.0.1', port, timeoutMs = 500 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (occupied) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * 启动后自检：默认端口必须是 8787；若历史漂移端口（8878）上仍有进程监听，
 * 返回告警事件供调用方记录日志。日志只包含事件名与端口，不包含任何密钥。
 */
export async function collectPortDriftWarnings({
  activePort,
  host = '127.0.0.1',
  historicalPorts = HISTORICAL_DRIFT_PORTS,
  detect = detectPortDrift,
} = {}) {
  const warnings = [];
  if (Number.isInteger(activePort) && activePort !== DEFAULT_MCP_PORT) {
    warnings.push({ event: 'mcp_port_not_default', activePort });
  }
  for (const port of historicalPorts) {
    if (port === activePort) continue;
    if (await detect({ host, port })) {
      warnings.push({ event: 'mcp_port_drift_detected', port });
    }
  }
  return warnings;
}
