import { workerConfig } from '../../uptime.config'
import { formatStatusChangeNotification, getWorkerLocation, notifyWithApprise, notifyWithTeams } from './util'
import { MonitorState, MonitorTarget } from '../../uptime.types'
import { getStatus } from './monitor'
import { DurableObject } from 'cloudflare:workers'

export interface Env {
  UPTIMEFLARE_STATE: KVNamespace
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  TEAMS_WEBHOOK_URL: string
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const workerLocation = (await getWorkerLocation()) || 'ERROR'
    console.log(`Running scheduled event on ${workerLocation}...`)

    // Auxiliary function to format notification and send it via apprise
    let formatAndNotify = async (
      monitor: MonitorTarget,
      isUp: boolean,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => {
      // Skip notification if monitor is in the skip list
      // @ts-ignore
      const skipList: string[] = workerConfig.notification?.skipNotificationIds
      if (skipList && skipList.includes(monitor.id)) {
        console.log(`Skipping notification for ${monitor.name} (${monitor.id} in skipNotificationIds)`)
        return
      }

      const notification = formatStatusChangeNotification(
        monitor,
        isUp,
        timeIncidentStart,
        timeNow,
        reason,
        workerConfig.notification?.timeZone ?? 'Etc/GMT'
      )

      // Send Apprise notification if configured
      if (workerConfig.notification?.appriseApiServer && workerConfig.notification?.recipientUrl) {
        await notifyWithApprise(
          workerConfig.notification.appriseApiServer,
          workerConfig.notification.recipientUrl,
          notification.title,
          notification.body
        )
      } else {
        console.log(`Apprise API server or recipient URL not set, skipping apprise notification for ${monitor.name}`)
      }

      // Send Teams notification if configured
      if (workerConfig.notification?.teamsEnabled && env.TEAMS_WEBHOOK_URL) {
        await notifyWithTeams(
          env.TEAMS_WEBHOOK_URL,
          notification // Pass the whole notification object
        )
      } else if (workerConfig.notification?.teamsEnabled) {
        console.log(`Teams notifications enabled in config but TEAMS_WEBHOOK_URL secret is not set, skipping Teams notification for ${monitor.name}`)
      } else {
        console.log(`Teams notifications disabled in config, skipping Teams notification for ${monitor.name}`)
      }
    }

    // Read state, set init state if it doesn't exist
    let state =
      ((await env.UPTIMEFLARE_STATE.get('state', {
        type: 'json',
      })) as unknown as MonitorState) ||
      ({
        version: 1,
        lastUpdate: 0,
        overallUp: 0,
        overallDown: 0,
        incident: {},
        latency: {},
      } as MonitorState)
    state.overallDown = 0
    state.overallUp = 0

    let statusChanged = false
    const currentTimeSecond = Math.round(Date.now() / 1000)

    // Check each monitor
    // TODO: concurrent status check
    for (const monitor of workerConfig.monitors) {
      console.log(`[${workerLocation}] Checking ${monitor.name}...`)

      let monitorStatusChanged = false
      let checkLocation = workerLocation
      let status

      if (monitor.checkProxy) {
        // Initiate a check using proxy (Geo-specific monitoring)
        try {
          console.log('Calling check proxy: ' + monitor.checkProxy)
          let resp
          if (monitor.checkProxy.startsWith("worker://")) {
            const doLoc = monitor.checkProxy.replace("worker://", "")
            const doId = env.REMOTE_CHECKER_DO.idFromName(doLoc)
            const doStub = env.REMOTE_CHECKER_DO.get(doId, {
              locationHint: doLoc as DurableObjectLocationHint
            })
            resp = await doStub.getLocationAndStatus(monitor)
          } else {
            resp = await (
              await fetch(monitor.checkProxy, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(monitor),
              })
            ).json<{location: string; status: {ping: number; up: boolean; err: string}}>()
          }
          checkLocation = resp.location
          status = resp.status
        } catch (err) {
          console.log('Error calling proxy: ' + err)
          if (monitor.checkProxyFallback) {
            console.log('Falling back to local check...')
            status = await getStatus(monitor)
          } else {
            status = { ping: 0, up: false, err: 'Error initiating check from remote worker' }
          }
        }
      } else {
        // Initiate a check from the current location
        status = await getStatus(monitor)
      }

      // const status = await getStatus(monitor)
      const currentTimeSecond = Math.round(Date.now() / 1000)

      // Update counters
      status.up ? state.overallUp++ : state.overallDown++

      // Update incidents
      // Create a dummy incident to store the start time of the monitoring and simplify logic
      state.incident[monitor.id] = state.incident[monitor.id] || [
        {
          start: [currentTimeSecond],
          end: currentTimeSecond,
          error: ['dummy'],
        },
      ]
      // Then lastIncident here must not be undefined
      let lastIncident = state.incident[monitor.id].slice(-1)[0]

      if (status.up) {
        // Current status is up
        // close existing incident if any
        if (lastIncident.end === undefined) {
          lastIncident.end = currentTimeSecond
          monitorStatusChanged = true
          try {
            if (
              // grace period not set OR ...
              workerConfig.notification?.gracePeriod === undefined ||
              // only when we have sent a notification for DOWN status, we will send a notification for UP status (within 30 seconds of possible drift)
              currentTimeSecond - lastIncident.start[0] >= (workerConfig.notification.gracePeriod + 1) * 60 - 30
            ) {
              await formatAndNotify(
                monitor,
                true,
                lastIncident.start[0],
                currentTimeSecond,
                'OK'
              )
            } else {
              console.log(`grace period (${workerConfig.notification?.gracePeriod}m) not met, skipping apprise UP notification for ${monitor.name}`)
            }

            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks.onStatusChange(
              env,
              monitor,
              true,
              lastIncident.start[0],
              currentTimeSecond,
              'OK'
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        }
      } else {
        // Current status is down
        // open new incident if not already open
        if (lastIncident.end !== undefined) {
          state.incident[monitor.id].push({
            start: [currentTimeSecond],
            end: undefined,
            error: [status.err],
          })
          monitorStatusChanged = true
        } else if (
          lastIncident.end === undefined &&
          lastIncident.error.slice(-1)[0] !== status.err
        ) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.err)
          monitorStatusChanged = true
        }

        const currentIncident = state.incident[monitor.id].slice(-1)[0]
        try {
          if (
            // monitor status changed AND...
            (monitorStatusChanged && (
              // grace period not set OR ...
              workerConfig.notification?.gracePeriod === undefined ||
              // have sent a notification for DOWN status
              currentTimeSecond - currentIncident.start[0] >= (workerConfig.notification.gracePeriod + 1) * 60 - 30
            ))
            ||
            (
              // grace period is set AND...
              workerConfig.notification?.gracePeriod !== undefined &&
              (
                // grace period is met
                currentTimeSecond - currentIncident.start[0] >= workerConfig.notification.gracePeriod * 60 - 30 &&
                currentTimeSecond - currentIncident.start[0] < workerConfig.notification.gracePeriod * 60 + 30
              )
            )) {
            await formatAndNotify(
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          } else {
            console.log(`Grace period (${workerConfig.notification?.gracePeriod}m) not met (currently down for ${currentTimeSecond - currentIncident.start[0]}s, changed ${monitorStatusChanged}), skipping apprise DOWN notification for ${monitor.name}`)
          }

          if (monitorStatusChanged) {
            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks.onStatusChange(
              env,
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          }
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
        }

        try {
          console.log('Calling config onIncident callback...')
          await workerConfig.callbacks.onIncident(
            env,
            monitor,
            currentIncident.start[0],
            currentTimeSecond,
            status.err
          )
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
        }
      }

      // append to latency data
      let latencyLists = state.latency[monitor.id] || {
        recent: [],
      }
      latencyLists.all = []

      const record = {
        loc: checkLocation,
        ping: status.ping,
        time: currentTimeSecond,
      }
      latencyLists.recent.push(record)

      // discard old data
      while (latencyLists.recent[0]?.time < currentTimeSecond - 12 * 60 * 60) {
        latencyLists.recent.shift()
      }
      state.latency[monitor.id] = latencyLists

      // discard old incidents
      let incidentList = state.incident[monitor.id]
      while (incidentList.length > 0 && incidentList[0].end && incidentList[0].end < currentTimeSecond - 90 * 24 * 60 * 60) {
        incidentList.shift()
      }

      if (incidentList.length == 0 || (
        incidentList[0].start[0] > currentTimeSecond - 90 * 24 * 60 * 60 &&
        incidentList[0].error[0] != 'dummy'
      )) {
        // put the dummy incident back
        incidentList.unshift(
          {
            start: [currentTimeSecond - 90 * 24 * 60 * 60],
            end: currentTimeSecond - 90 * 24 * 60 * 60,
            error: ['dummy'],
          }
        )
      }
      state.incident[monitor.id] = incidentList

      statusChanged ||= monitorStatusChanged
    }

    console.log(`statusChanged: ${statusChanged}, lastUpdate: ${state.lastUpdate}, currentTime: ${currentTimeSecond}`)
    // Update state
    // Allow for a cooldown period before writing to KV
    if (
      statusChanged ||
      currentTimeSecond - state.lastUpdate >= workerConfig.kvWriteCooldownMinutes * 60 - 10  // Allow for 10 seconds of clock drift
    ) {
      console.log("Updating state...")
      state.lastUpdate = currentTimeSecond
      await env.UPTIMEFLARE_STATE.put('state', JSON.stringify(state))
    } else {
      console.log("Skipping state update due to cooldown period.")
    }
  },
}

export class RemoteChecker extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async getLocationAndStatus(monitor: MonitorTarget): Promise<{location: string; status: {ping: number; up: boolean; err: string}}> {
    const colo = await getWorkerLocation() as string
    console.log(`Running remote checker (DurableObject) at ${colo}...`)
    const status = await getStatus(monitor)
    return {
      location: colo,
      status: status,
    }
  }
}
