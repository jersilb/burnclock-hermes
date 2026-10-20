// Burnclock — status-bar chip with the provider balance and runway.
//
// Data path: `shell.exec` runs `burnclock badge --json`, which reads burnclock's
// local cache and returns in milliseconds. The plugin never reads env files or
// credentials and makes no network calls; the CLI owns provider access. A stale
// cache is refreshed by the CLI itself when the user runs `burnclock badge
// --refresh` in a terminal, where their provider keys are available.
//
// Requires: burnclock CLI on PATH (pip install burnclock).

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
// The gateway runs shell.exec with a sanitized PATH that does not always include
// ~/.local/bin (where pip --user and pipx put the CLI), so resolve once across
// the common install locations instead of trusting PATH alone.
const CLI_CMD = 'BIN="$(command -v burnclock || true)"; for c in "$BIN" "$HOME/.local/bin/burnclock" /opt/homebrew/bin/burnclock /usr/local/bin/burnclock; do if [ -n "$c" ] && [ -x "$c" ]; then exec "$c" badge --json; fi; done; echo "burnclock not found" >&2; exit 127'
const REFRESH_MS = 60_000

function badgeQuery() {
  return {
    queryKey: [ID, 'badge'],
    queryFn: async () => {
      const params = { command: CLI_CMD }
      // The gateway's session-bound shell.exec rejects a command-only request
      // with invalid_params; bind it to the session the user is looking at.
      const sid = host.state.activeSessionId.get()
      if (sid) params.session_id = sid
      const res = await host.request('shell.exec', params)
      // Exit 4/5/6 is a worst-of-status code from collecting several providers,
      // not necessarily this row's; a valid JSON payload is success.
      const out = res && typeof res.stdout === 'string' ? res.stdout.trim() : ''
      if (!out) return null
      try {
        const data = JSON.parse(out)
        return data && data.provider ? data : null
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
    return 'Burnclock — could not run `burnclock badge`. Install the CLI (pip install burnclock) and make sure it is on PATH.'
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
