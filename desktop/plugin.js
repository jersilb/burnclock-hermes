// Burnclock — status-bar chip with the provider balance and runway.
//
// Data path: the plugin reads burnclock's local cache files directly
// (`badge.txt` for the one-line label, `badge.json` for status/runway) via one
// `shell.exec` cat. It never runs the CLI, so it can never trigger a refresh,
// never touches provider keys and makes no network calls. The CLI owns
// collection; the user populates the cache by running `burnclock badge
// --refresh` in a terminal where their keys are available.
//
// Requires: the burnclock CLI (pip install burnclock) to populate the cache.

import {
  Codicon,
  StatusDot,
  Tip,
  cn,
  haptic,
  host,
  useQuery
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'burnclock'
// Resolve the cache the same way burnclock does: BURNCLOCK_BADGE_CACHE wins,
// then XDG_CACHE_HOME, then ~/.cache. Read only — never execute the CLI here,
// because `burnclock badge` spawns a refresh when the cache is stale and a
// refresh without provider keys would overwrite a good cache with an error row.
const CACHE_CMD = 'J="${BURNCLOCK_BADGE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/burnclock/badge.json}"; T="${J%.json}.txt"; [ -f "$J" ] || exit 3; if [ -f "$T" ]; then sed -n \'1p\' "$T"; fi; echo "@@"; cat "$J"'
const REFRESH_MS = 60_000

function badgeQuery() {
  return {
    queryKey: [ID, 'badge'],
    queryFn: async () => {
      const params = { command: CACHE_CMD }
      // The gateway's session-bound shell.exec rejects a command-only request
      // with invalid_params; bind it to the session the user is looking at.
      const sid = host.state.activeSessionId.get()
      if (sid) params.session_id = sid
      const res = await host.request('shell.exec', params)
      const out = res && typeof res.stdout === 'string' ? res.stdout.trim() : ''
      if (!out) return null
      const cut = out.indexOf('\n@@\n')
      if (cut < 0) return null
      const line = out.slice(0, cut).trim()
      try {
        const data = JSON.parse(out.slice(cut + 4))
        if (!data || !data.provider) return null
        return line ? { ...data, line } : data
      } catch {
        return null
      }
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS / 2,
    retry: 0
  }
}

function toneOf(provider) {
  if (!provider) return 'muted'
  if (provider.status !== 'OK') return 'bad'
  const runway = runtimeRunway(provider)
  if (runway == null) return 'muted'
  if (runway < 2) return 'bad'
  if (runway < 5) return 'warn'
  return 'good'
}

function runtimeRunway(provider) {
  const r = provider.runway_days ?? provider.runway_days_paid ?? provider.forecast?.runway_days_paid
  return typeof r === 'number' && Number.isFinite(r) ? r : null
}

function tooltip(data, error) {
  if (error) {
    return 'Burnclock — could not read the burnclock cache (~/.cache/burnclock/badge.json). Run `burnclock badge --refresh` in a terminal once, then this chip updates from the cache.'
  }
  if (!data || !data.provider) {
    return 'Burnclock — no cached balance yet. Run `burnclock badge --refresh` in a terminal once, then this chip updates from the cache.'
  }
  const p = data.provider
  const runway = runtimeRunway(p)
  const parts = [
    `Burnclock — ${p.label || p.id}`,
    p.balance ? `${p.balance.amount} ${p.balance.currency}` : p.status,
    runway != null ? `${runway.toFixed(1)} days runway` : 'runway unknown'
  ]
  if (data.updated_at) {
    parts.push(`updated ${String(data.updated_at).replace('T', ' ').replace('Z', ' UTC')}`)
  }
  return parts.join(' · ')
}

function BurnclockChip() {
  const q = useQuery(badgeQuery())
  const data = q.data
  const p = data?.provider
  const text = data?.line || 'burnclock —'

  return jsx(Tip, {
    label: tooltip(data, q.error),
    children: jsx('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: tooltip(data, q.error) })
        void q.refetch()
      },
      children: [
        jsx(Codicon, { name: 'watch', size: 11, className: 'opacity-70' }),
        jsx(StatusDot, { tone: toneOf(p) }),
        jsx('span', { children: text })
      ]
    })
  })
}

export default {
  id: ID,
  name: 'Burnclock',
  register(ctx) {
    ctx.register({
      id: 'burnclock-chip',
      area: 'statusBar.right',
      order: 105,
      render: () => jsx(BurnclockChip, {})
    })
  }
}
