type MonitorState = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  incident: Record<
    string,
    {
      start: number[]
      end: number | undefined // undefined if it's still open
      error: string[]
    }[]
  >

  latency: Record<
    string,
    {
      recent: {
        loc: string
        ping: number
        time: number
      }[] // recent 12 hour data, 2 min interval
      all: {
        loc: string
        ping: number
        time: number
      }[] // all data in 90 days, 1 hour interval
    }
  >
}

type MonitorTarget = {
  id: string
  name: string
  method: string // "TCP_PING" or Http Method (e.g. GET, POST, OPTIONS, etc.)
  target: string // url for http, hostname:port for tcp
  tooltip?: string
  statusPageLink?: string
  hideLatencyChart?: boolean
  checkProxy?: string
  checkProxyFallback?: boolean

  // HTTP Code
  expectedCodes?: number[]
  timeout?: number
  headers?: Record<string, string | undefined>
  body?: BodyInit
  responseKeyword?: string
  responseForbiddenKeyword?: string
}

type NotificationConfig = {
  // Apprise configuration
  appriseApiServer?: string
  recipientUrl?: string
  
  // Microsoft Teams webhook configuration
  teamsWebhookUrl?: string
  
  // General notification settings
  timeZone?: string
  gracePeriod?: number
  skipNotificationIds?: string[]
}

// Extend WorkerConfig to include notification
type WorkerConfig = {
  kvWriteCooldownMinutes: number
  passwordProtection?: string
  monitors: MonitorTarget[]
  notification?: NotificationConfig
  callbacks: {
    onStatusChange: (
      env: any,
      monitor: MonitorTarget,
      isUp: boolean,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => Promise<void>
    onIncident: (
      env: any,
      monitor: MonitorTarget,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => Promise<void>
  }
}

type TeamsNotification = {
  title: string
  body: string
  monitorName?: string
  status?: string
  downtimeDuration?: string
  reason?: string
}

export type { MonitorState, MonitorTarget, NotificationConfig, WorkerConfig, TeamsNotification }
