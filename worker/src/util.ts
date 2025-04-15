import type { TeamsNotification } from '../../uptime.types'

async function getWorkerLocation() {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace')
  const text = await res.text()

  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  return colo
}

const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const promise = fetch(url, { signal: controller.signal, ...options })
  if (signal) signal.addEventListener('abort', () => controller.abort())
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => clearTimeout(timeout))
}

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  const timeout = new Promise<T>((resolve, reject) =>
    setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  )

  return Promise.race([promise, timeout])
}

function formatStatusChangeNotification(
  monitor: any,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string,
  timeZone: string
) {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone,
  })

  let downtimeDuration = Math.round((timeNow - timeIncidentStart) / 60);
  const timeNowFormatted = dateFormatter.format(new Date(timeNow * 1000))
  const timeIncidentStartFormatted = dateFormatter.format(new Date(timeIncidentStart * 1000))

  if (isUp) {
    return {
      title: `✅ ${monitor.name} is up!`,
      body: `The service is up again after being down for ${downtimeDuration} minutes.`,
      monitorName: monitor.name,
      status: "Up",
      downtimeDuration: `${downtimeDuration} minutes`,
      reason: "OK"
    }
  } else if (timeNow == timeIncidentStart) {
    return {
      title: `🔴 ${monitor.name} is currently down.`,
      body: `Service is unavailable at ${timeNowFormatted}. Issue: ${reason || 'unspecified'}`,
      monitorName: monitor.name,
      status: "Down",
      downtimeDuration: `0 minutes`,
      reason: reason || 'unspecified'
    }
  } else {
    return {
      title: `🔴 ${monitor.name} is still down.`,
      body: `Service is unavailable since ${timeIncidentStartFormatted} (${downtimeDuration} minutes). Issue: ${reason || 'unspecified'}`,
      monitorName: monitor.name,
      status: "Down",
      downtimeDuration: `${downtimeDuration} minutes`,
      reason: reason || 'unspecified'
    }
  }
}

async function notifyWithApprise(
  appriseApiServer: string,
  recipientUrl: string,
  title: string,
  body: string
) {
  console.log('Sending Apprise notification: ' + title + '-' + body + ' to ' + recipientUrl + ' via ' + appriseApiServer)
  try {
    const resp = await fetchTimeout(appriseApiServer, 5000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        urls: recipientUrl,
        title,
        body,
        type: 'warning',
        format: 'text'
      }),
    })

    if (!resp.ok) {
      console.log('Error calling apprise server, code: ' + resp.status + ', response: ' + await resp.text())
    } else {
      console.log('Apprise notification sent successfully, code: ' + resp.status)
    }
  } catch (e) {
    console.log('Error calling apprise server: ' + e)
  }
}

/*
Adaptive Card Schema Reference:
{
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    {
      "type": "TextBlock",
      "text": "${title}",
      "weight": "bolder",
      "size": "large",
      "wrap": true
    },
    {
      "type": "TextBlock",
      "text": "${text}",
      "wrap": true,
      "spacing": "medium"
    },
    {
      "type": "FactSet",
      "facts": [
        {
          "title": "Monitor:",
          "value": "${monitorName}"
        },
        {
          "title": "Status:",
          "value": "${status}"
        },
        {
          "title": "Downtime:",
          "value": "${downtimeDuration}"
        },
        {
          "title": "Reason:",
          "value": "${reason}"
        }
      ]
    }
  ]
}
*/

/**
 * Send a notification to Microsoft Teams via webhook
 * @param webhookUrl - The Teams webhook URL to send the notification to
 * @param notification - The notification object containing the title, body, and other details
 */	
async function notifyWithTeams(
  webhookUrl: string,
  notification: TeamsNotification
) {
  console.log('Sending Teams notification (raw JSON): ' + notification.title + '-' + notification.body + ' to ' + webhookUrl)
  try {
    // Send the notification object as JSON, mapping 'body' to 'text'
    const payload = {
      title: notification.title,
      text: notification.body,
      monitorName: notification.monitorName,
      status: notification.status,
      downtimeDuration: notification.downtimeDuration,
      reason: notification.reason
    }

    const resp = await fetchTimeout(webhookUrl, 5000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      console.log('Error calling Teams webhook, status: ' + resp.status + ', response: ' + await resp.text())
    } else {
      console.log('Teams notification sent successfully, status: ' + resp.status)
    }
  } catch (e) {
    console.log('Error calling Teams webhook: ' + e)
  }
}

export { getWorkerLocation, fetchTimeout, withTimeout, notifyWithApprise, notifyWithTeams, formatStatusChangeNotification }
