export type Tier = 'low' | 'medium' | 'high' | 'extraHigh' | 'ultra'

export type Feature = 'chat' | 'agent' | 'code' | 'research' | 'news'

export type ProcessName = 'tools' | 'engine' | (string & {})

export type ProcessState =
  | 'stopped'
  | 'spawning'
  | 'waiting_healthy'
  | 'running'
  | 'unhealthy'
  | 'restarting'
  | 'failed'

export interface ProcessSnapshot {
  name: ProcessName
  state: ProcessState
  port: number | null
  pid: number | null
  /** Human-readable detail, e.g. last error or restart reason. */
  detail?: string
}

export interface SystemStatus {
  version: string
  dataDir: string
  processes: ProcessSnapshot[]
}
