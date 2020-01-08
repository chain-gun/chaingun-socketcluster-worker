export const PEERS_CONFIG_FILE = process.env.PEERS_CONFIG_FILE || './peers.yaml'

export const PEER_SYNC_INTERVAL =
  parseInt(process.env.PEER_SYNC_INTERVAL, 10) || 1000

export const PEER_PRUNE_INTERVAL =
  parseInt(process.env.PEER_PRUNE_INTERVAL, 10) || 60 * 60 * 1000

export const PEER_CHANGELOG_RETENTION =
  parseInt(process.env.PEER_CHANGELOG_RETENTION, 10) || 24 * 60 * 60 * 1000

export const SSE_PING_INTERVAL =
  parseInt(process.env.SSE_PING_INTERVAL, 10) || 30 * 1000
