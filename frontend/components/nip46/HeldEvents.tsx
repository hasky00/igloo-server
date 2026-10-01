import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'

// Delay-gated events (profile, delete, …) the share nodes are holding. The
// gateway re-requests and publishes them after the delay; see
// src/cinderella/held-events.ts.

export interface HeldEventApi {
  id: string
  kind: number
  eventId: string
  createdAt: number
  preview: string
  status: 'held' | 'signed' | 'published' | 'failed' | 'cancelled' | 'superseded' | 'vetoed'
  unlockAt: string
  nextAttemptAt: string
  attempts: number
  vetoedBy: string | null
  publishResults: Record<string, string> | null
  lastError: string | null
}

const KIND_NAMES: Record<number, string> = { 0: 'Profile', 5: 'Deletion', 10063: 'Media servers' }

const STATUS_VARIANT: Record<HeldEventApi['status'], 'info' | 'warning' | 'success' | 'error' | 'default' | 'purple'> = {
  held: 'warning',
  signed: 'info',
  published: 'success',
  failed: 'error',
  cancelled: 'default',
  superseded: 'default',
  vetoed: 'purple',
}

interface HeldEventsProps {
  authHeaders?: Record<string, string>
}

export function HeldEvents({ authHeaders }: HeldEventsProps) {
  const [events, setEvents] = useState<HeldEventApi[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ npub: string | null; nodeAlertPubkeys: string[] } | null>(null)

  useEffect(() => {
    fetch('/api/held-events/notice-key', { headers: authHeaders })
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (body) setNotice(body) })
      .catch(() => {})
  }, [authHeaders])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/held-events', { headers: authHeaders })
      if (res.status === 503) {
        setEvents([])
        setError('Signer not running: log in to see held events.')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      setEvents(Array.isArray(body?.events) ? body.events : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load held events')
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => {
    void load()
    const interval = setInterval(() => { void load() }, 30_000)
    return () => clearInterval(interval)
  }, [load])

  const cancel = async (id: string) => {
    setCancelling(id)
    try {
      const res = await fetch(`/api/held-events/${id}`, { method: 'DELETE', headers: authHeaders })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel')
    } finally {
      setCancelling(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Profile changes and deletions are held by the share nodes before they can be signed. The gateway
        requests them again after the delay and publishes them. To stop one for good, veto it from your
        phone (reply to the node's alert): it then shows as vetoed here. Cancel only stops this gateway
        from re-requesting it; it is not a veto against someone holding a stolen share.
      </p>
      {notice && (
        <div className="rounded border border-gray-700 bg-gray-900/40 p-3 text-xs text-gray-300">
          <p>
            Gateway notice npub (put it in each share node's <code>veto.gateway_pubkey</code>, so vetoes show here):
          </p>
          {notice.npub
            ? <code className="mt-1 block break-all text-blue-200">{notice.npub}</code>
            : <p className="mt-1 text-gray-400">Created when you unlock the signer (headless: set NOTICE_SECRET).</p>}
          {notice.nodeAlertPubkeys.length === 0 && (
            <p className="mt-1 text-yellow-400">NODE_ALERT_PUBKEYS is not set: vetoes from share nodes are not shown.</p>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {!loading && !error && events.length === 0 && <p className="text-sm text-gray-500">No held events.</p>}
      <ul className="space-y-2">
        {events.map(ev => (
          <li key={ev.id} className="rounded border border-gray-700 bg-gray-800/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-blue-200">{KIND_NAMES[ev.kind] ?? `Kind ${ev.kind}`}</span>
              <Badge variant={STATUS_VARIANT[ev.status]}>{ev.status}</Badge>
              <span className="text-gray-400">
                {ev.status === 'held'
                  ? `unlocks ${new Date(ev.unlockAt).toLocaleString()}`
                  : `created ${new Date(ev.createdAt * 1000).toLocaleString()}`}
              </span>
              {(ev.status === 'held' || ev.status === 'vetoed') && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={cancelling === ev.id}
                  onClick={() => { void cancel(ev.id) }}
                >
                  {cancelling === ev.id ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
            </div>
            {ev.status === 'vetoed' && (
              <p className="mt-1 text-xs text-purple-300">
                Vetoed from the veto key{ev.vetoedBy ? <> (reported by share node <code className="break-all">{ev.vetoedBy}</code>)</> : null}. It will never be signed.
              </p>
            )}
            {ev.preview && <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-gray-300">{ev.preview}</pre>}
            {ev.lastError && <p className="mt-1 text-xs text-yellow-400">Last attempt: {ev.lastError}</p>}
            {ev.publishResults && (
              <p className="mt-1 text-xs text-gray-400">
                {Object.entries(ev.publishResults).map(([relay, r]) => `${relay}: ${r}`).join(' · ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
