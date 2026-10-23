// Burnclock — status-bar chip plus a workspace dashboard page.
//
// Data path: the chip reads burnclock's local cache files directly
// (`badge.txt` for the one-line label, `badge.json` for status/runway) via one
// `shell.exec` cat. It never runs the CLI, so it can never trigger a refresh,
// never touches provider keys and makes no network calls. The dashboard page
// also reads the cache for balance/runway, and runs only the pure-clock
// `burnclock offpeak --json` command for the DeepSeek window. A balance refresh
// is an explicit button, never a background poll.
//
// Requires: the burnclock CLI (pip install burnclock) to populate the cache.

import {
  Button,
  Codicon,
  StatusDot,
  Tip,
  cn,
  haptic,
  host,
  useQuery
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useState } from 'react'

const ID = 'burnclock'
const ROUTE = '/burnclock'
// Resolve the cache the same way burnclock does: BURNCLOCK_BADGE_CACHE wins,
// then XDG_CACHE_HOME, then ~/.cache. Read only — never execute the CLI here,
// because `burnclock badge` spawns a refresh when the cache is stale and a
// refresh without provider keys would overwrite a good cache with an error row.
const CACHE_CMD = 'J="${BURNCLOCK_BADGE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/burnclock/badge.json}"; T="${J%.json}.txt"; [ -f "$J" ] || exit 3; if [ -f "$T" ]; then sed -n \'1p\' "$T"; fi; echo "@@"; cat "$J"'
// `offpeak` is pure clock math: no provider key, no network, no cache write.
// Do not pass --timezone local: 0.1.5 rejects the alias; the default is local.
const CLI_CMD = 'BIN="${BURNCLOCK_BIN:-$(command -v burnclock 2>/dev/null || true)}"; [ -n "$BIN" ] || BIN="$HOME/.local/bin/burnclock"; [ -x "$BIN" ] || exit 127; '
const OFFPEAK_CMD = CLI_CMD + '"$BIN" offpeak --json 2>/dev/null'
// The refresh needs provider keys. shell.exec has a sanitized environment, so
// prefer the Hermes shim, which reads only the six allowlisted key names from
// ~/.hermes/.env. Fall back to the PATH binary for installs without the skill.
const REFRESH_CMD =
  'SHIM="${BURNCLOCK_SHIM:-$HOME/.hermes/skills/burnclock/scripts/burnclock-shim.sh}"; ' +
  'if [ -r "$SHIM" ]; then bash "$SHIM" badge --refresh; exit $?; fi; ' +
  CLI_CMD +
  '"$BIN" badge --refresh'
const REFRESH_MS = 60_000

async function runShellResult(command) {
  const params = { command }
  // The gateway's session-bound shell.exec rejects a command-only request
  // with invalid_params; bind it to the session the user is looking at.
  const sid = host.state && host.state.activeSessionId && host.state.activeSessionId.get()
  if (sid) params.session_id = sid
  return host.request('shell.exec', params)
}

async function runShell(command) {
  const res = await runShellResult(command)
  return res && typeof res.stdout === 'string' ? res.stdout.trim() : ''
}

function badgeQuery() {
  return {
    queryKey: [ID, 'badge'],
    queryFn: async () => {
      const out = await runShell(CACHE_CMD)
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

const offpeakQuery = {
  queryKey: [ID, 'offpeak'],
  queryFn: async () => {
    const out = await runShell(OFFPEAK_CMD)
    if (!out) return null
    try {
      const data = JSON.parse(out)
      return data && data.kind === 'offpeak' ? data : null
    } catch {
      return null
    }
  },
  refetchInterval: REFRESH_MS,
  staleTime: REFRESH_MS / 2,
  retry: 0
}

function runtimeRunway(provider) {
  const r = provider.runway_days ?? provider.runway_days_paid ?? provider.forecast?.runway_days_paid
  return typeof r === 'number' && Number.isFinite(r) ? r : null
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

function fmtDuration(seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return '0m'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (!days && mins) parts.push(`${mins}m`)
  return parts.length ? parts.join(' ') : '0m'
}

function refreshIssue(code) {
  if (code === 4) return 'a provider key was rejected or missing'
  if (code === 5) return 'a provider is below its configured threshold'
  if (code === 6) return 'a provider was unreachable'
  if (code === 3) return 'the provider config needs attention'
  if (code === 1) return 'a provider check hit an internal error'
  return `a provider check exited ${code}`
}

function updatedLabel(value) {
  if (!value) return 'not yet refreshed'
  return String(value).replace('T', ' ').replace('Z', ' UTC')
}

function tooltip(data, error) {
  if (error) {
    return 'Burnclock — could not read the burnclock cache (~/.cache/burnclock/badge.json). Run `burnclock badge --refresh` in a terminal once, then open the dashboard.'
  }
  if (!data || !data.provider) {
    return 'Burnclock — no cached balance yet. Run `burnclock badge --refresh` in a terminal once, then open the dashboard.'
  }
  const p = data.provider
  const runway = runtimeRunway(p)
  const parts = [
    `Burnclock — ${p.label || p.id}`,
    p.balance ? `${p.balance.amount} ${p.balance.currency}` : p.status,
    runway != null ? `${runway.toFixed(1)} days runway` : 'runway unknown'
  ]
  if (data.updated_at) parts.push(`updated ${updatedLabel(data.updated_at)}`)
  parts.push('Click for dashboard')
  return parts.join(' · ')
}

// ── shared little pieces ────────────────────────────────────────────────────

function Card({ title, aside, children }) {
  return jsxs('section', {
    className: 'rounded-xl border border-(--ui-stroke-secondary) p-4',
    children: [
      jsxs('div', {
        className: 'mb-3 flex items-center gap-2',
        children: [
          jsx('h2', {
            className: 'text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
            children: title
          }),
          jsx('div', { className: 'flex-1' }),
          aside || null
        ]
      }),
      children
    ]
  })
}

function Stat({ label, value, hint }) {
  return jsxs('div', {
    className: 'rounded-lg border border-(--ui-stroke-secondary)/60 p-2.5',
    children: [
      jsx('div', {
        className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)',
        children: label
      }),
      jsx('div', {
        className: 'mt-0.5 text-[0.8125rem] font-medium text-foreground',
        children: value
      }),
      hint
        ? jsx('div', {
            className: 'mt-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
            children: hint
          })
        : null
    ]
  })
}

function Command({ label, command, note }) {
  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary)/60 py-2 last:border-0',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-3',
        children: [
          jsx('span', {
            className: 'text-[0.75rem] text-foreground',
            children: label
          }),
          jsx('code', {
            className: 'max-w-[62%] break-all rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-right text-[0.625rem] text-(--ui-text-tertiary)',
            children: command
          })
        ]
      }),
      note
        ? jsx('div', {
            className: 'mt-0.5 text-[0.625rem] text-(--ui-text-quaternary)',
            children: note
          })
        : null
    ]
  })
}

function Feature({ name, children }) {
  return jsxs('div', {
    className: 'flex gap-2',
    children: [
      jsx('span', {
        className: 'mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-(--ui-accent)'
      }),
      jsxs('div', {
        children: [
          jsx('div', { className: 'text-[0.75rem] text-foreground', children: name }),
          jsx('div', {
            className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
            children
          })
        ]
      })
    ]
  })
}

// ── chip ────────────────────────────────────────────────────────────────────

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
      'aria-label': `Burnclock: ${text}. Open dashboard.`,
      onClick: () => {
        haptic('tap')
        host.navigate(ROUTE)
      },
      children: [
        jsx(Codicon, { name: 'watch', size: 11, className: 'opacity-70' }),
        jsx(StatusDot, { tone: toneOf(p) }),
        jsx('span', { children: text })
      ]
    })
  })
}

// ── dashboard page ──────────────────────────────────────────────────────────

function BurnclockPage() {
  const badgeQ = useQuery(badgeQuery())
  const offQ = useQuery(offpeakQuery)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const badge = badgeQ.data
  const p = badge?.provider
  const off = offQ.data
  const runway = runtimeRunway(p)
  const amount = p?.balance?.amount
  const limit = p?.budget?.limit
  const spent = p?.budget?.spent_est
  const overBudget = typeof spent === 'number' && typeof limit === 'number' && spent > limit
  const updated = updatedLabel(badge?.updated_at)

  const refresh = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const before = badge?.updated_at || ''
      const res = await runShellResult(REFRESH_CMD)
      const fresh = await badgeQ.refetch()
      await offQ.refetch()
      const code = typeof res?.code === 'number' ? res.code : 0
      const detail = String(res?.stderr || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-1)[0]
        ?.slice(0, 220)
      if (!fresh?.data) {
        setNotice({
          kind: 'error',
          text: 'The cache is still missing. Run `burnclock badge --refresh` in a terminal, then try again.'
        })
      } else if (fresh.data.updated_at !== before) {
        setNotice({
          kind: 'ok',
          text:
            code === 0
              ? 'Balance cache refreshed.'
              : `Cache refreshed; ${refreshIssue(code)}. The balance row is updated.`
        })
      } else if (code !== 0) {
        setNotice({
          kind: 'error',
          text: detail
            ? `Refresh failed: ${detail}`
            : `Refresh exited ${code} and the cache did not change.`
        })
      } else {
        setNotice({
          kind: 'ok',
          text: 'Already current; the cache was refreshed recently, so there was nothing new to write.'
        })
      }
    } catch {
      setNotice({
        kind: 'error',
        text: 'Could not refresh the cache. Run `burnclock badge --refresh` in a terminal, then try again.'
      })
    } finally {
      setBusy(false)
    }
  }, [badge?.updated_at, badgeQ, offQ, busy])

  const stateLabel = off?.state_label || (off?.state === 'peak' ? 'PEAK' : 'OFF-PEAK')
  const stateClass =
    off?.state === 'peak'
      ? 'border-(--ui-red)/40 text-(--ui-red)'
      : 'border-(--ui-stroke-secondary) text-(--ui-text-secondary)'
  const rec = off?.recommendation
  const offpeakHint = rec
    ? rec.action === 'start_now'
      ? `Start now — cheap until ${rec.run_until_display}.`
      : `Wait ${fmtDuration(rec.wait_seconds)}; next long window starts ${rec.start_display}.`
    : 'No recommendation available.'

  return jsxs('div', {
    className: 'mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto p-5',
    children: [
      jsxs('header', {
        className: 'flex items-start gap-3',
        children: [
          jsx('span', {
            className: 'mt-0.5 text-(--ui-text-secondary)',
            children: jsx(Codicon, { name: 'watch', size: 22 })
          }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('h1', {
                className: 'text-[0.9375rem] font-semibold text-foreground',
                children: 'Burnclock'
              }),
              jsx('p', {
                className: 'text-[0.75rem] text-(--ui-text-tertiary)',
                children: 'AI credit runway and the DeepSeek Flash off-peak clock. Estimates, not billing truth.'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                disabled: busy,
                onClick: () => void refresh(),
                children: [
                  jsx(Codicon, { key: 'refresh', name: busy ? 'loading~spin' : 'refresh' }),
                  jsx('span', { key: 'label', children: busy ? 'Refreshing…' : 'Refresh' })
                ]
              }),
              jsx('a', {
                href: 'https://burnclock.trinityone.cc/',
                target: '_blank',
                rel: 'noreferrer',
                className: 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-foreground',
                children: [
                  jsx(Codicon, { key: 'link', name: 'link-external' }),
                  jsx('span', { key: 'label', children: 'Website' })
                ]
              })
            ]
          })
        ]
      }),

      notice
        ? jsx('div', {
            className: cn(
              'rounded-lg px-3 py-2 text-[0.75rem]',
              notice.kind === 'error'
                ? 'bg-(--ui-red)/10 text-(--ui-red)'
                : 'bg-(--ui-accent)/10 text-(--ui-text-secondary)'
            ),
            children: notice.text
          })
        : null,

      jsxs('div', {
        className: 'grid gap-3 md:grid-cols-2',
        children: [
          jsx(Card, {
            title: 'Balance',
            aside: jsx('span', {
              className: 'text-[0.625rem] text-(--ui-text-quaternary)',
              children: updated
            }),
            children: jsxs('div', {
              children: [
                jsxs('div', {
                  className: 'flex items-end justify-between gap-3',
                  children: [
                    jsxs('div', {
                      children: [
                        jsx('div', {
                          className: 'text-[1.5rem] font-semibold tracking-tight text-foreground',
                          children: amount != null ? `$${Number(amount).toFixed(2)}` : '—'
                        }),
                        jsx('div', {
                          className: 'text-[0.75rem] text-(--ui-text-tertiary)',
                          children: p?.label || 'No cached provider'
                        })
                      ]
                    }),
                    jsx('span', {
                      className: cn(
                        'rounded-full border px-2 py-0.5 text-[0.625rem]',
                        p?.status === 'OK'
                          ? 'border-(--ui-stroke-secondary) text-(--ui-text-secondary)'
                          : 'border-(--ui-red)/40 text-(--ui-red)'
                      ),
                      children: p?.status || 'NO CACHE'
                    })
                  ]
                }),
                jsxs('div', {
                  className: 'mt-3 grid grid-cols-2 gap-2',
                  children: [
                    jsx(Stat, {
                      label: 'Runway',
                      value: runway != null ? `${runway.toFixed(1)} days` : '—',
                      hint: 'at recent burn'
                    }),
                    jsx(Stat, {
                      label: 'Budget',
                      value: limit != null ? `$${Number(limit).toFixed(0)}` : '—',
                      hint: spent != null ? `$${Number(spent).toFixed(2)} est. spent` : 'not set'
                    })
                  ]
                }),
                overBudget
                  ? jsx('div', {
                      className: 'mt-2 text-[0.6875rem] text-(--ui-red)',
                      children: `Over budget by $${(Number(spent) - Number(limit)).toFixed(2)} (estimate).`
                    })
                  : null,
                !p
                  ? jsx('div', {
                      className: 'mt-2 text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
                      children: 'No cache yet. Run `burnclock badge --refresh` in a terminal, then hit Refresh.'
                    })
                  : null
              ]
            })
          }),

          jsx(Card, {
            title: 'DeepSeek Flash off-peak',
            aside: jsx('a', {
              href: 'https://burnclock.trinityone.cc/#offpeak',
              target: '_blank',
              rel: 'noreferrer',
              className: 'text-[0.625rem] text-(--ui-text-tertiary) hover:text-foreground',
              children: 'How it works'
            }),
            children: off
              ? jsxs('div', {
                  children: [
                    jsxs('div', {
                      className: 'flex flex-wrap items-center gap-2',
                      children: [
                        jsx('span', {
                          className: cn(
                            'rounded-full border px-2 py-0.5 text-[0.625rem] font-medium tracking-wide',
                            stateClass
                          ),
                          children: stateLabel
                        }),
                        jsx('span', {
                          className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
                          children: off.now_display
                        })
                      ]
                    }),
                    jsx('div', {
                      className: 'mt-2 text-[0.8125rem] text-foreground',
                      children:
                        off.state === 'peak'
                          ? 'Peak rate. Running now costs 2× the off-peak rate.'
                          : 'Off-peak rate, 50% of peak.'
                    }),
                    jsx('div', {
                      className: 'mt-1 text-[0.75rem] text-(--ui-text-secondary)',
                      children: offpeakHint
                    }),
                    off.current?.ends_display
                      ? jsx('div', {
                          className: 'mt-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                          children:
                            off.state === 'peak'
                              ? `Peak ends ${off.current.ends_display}.`
                              : `Off-peak ends ${off.current.ends_display}.`
                        })
                      : null,
                    rec
                      ? jsx('div', {
                          className: 'mt-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                          children: `Window ${fmtDuration(rec.window_seconds)} · minimum ${rec.min_hours}h ${rec.meets_min_hours ? 'met' : 'not met'}.`
                        })
                      : null,
                    off.next_peak?.starts_display
                      ? jsx('div', {
                          className: 'mt-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                          children: `Next peak: ${off.next_peak.starts_display}.`
                        })
                      : null,
                    off.pricing
                      ? jsx('div', {
                          className: 'mt-2 text-[0.625rem] text-(--ui-text-tertiary)',
                          children: `$${off.pricing.offpeak.cache_miss_input}/M cache miss in · $${off.pricing.offpeak.output}/M out off-peak; peak is 2×.`
                        })
                      : null,
                    off.state_confidence === 'low' || (off.holiday_calendar && off.holiday_calendar.loaded === false)
                      ? jsx('div', {
                          className: 'mt-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-[0.625rem] leading-relaxed text-(--ui-text-tertiary)',
                          children: 'Caution: the holiday calendar is incomplete for this horizon, so peak boundaries may be wrong outside the bundled year.'
                        })
                      : null,
                    jsx('div', {
                      className: 'mt-2 text-[0.625rem] text-(--ui-text-quaternary)',
                      children: 'Scheduling guidance, not billing truth.'
                    })
                  ]
                })
              : jsx('div', {
                  className: 'text-[0.75rem] leading-relaxed text-(--ui-text-tertiary)',
                  children: 'No off-peak data. Is `burnclock` on PATH? Run `burnclock offpeak` in a terminal to check.'
                })
          })
        ]
      }),

      jsx(Card, {
        title: 'Commands',
        aside: jsx('span', {
          className: 'text-[0.625rem] text-(--ui-text-quaternary)',
          children: 'run in a terminal'
        }),
        children: jsxs('div', {
          children: [
            jsx(Command, {
              label: 'Balance and runway',
              command: 'burnclock status',
              note: 'Current provider row with status and alerts.'
            }),
            jsx(Command, {
              label: 'Forecast',
              command: 'burnclock forecast',
              note: 'Runway range and budget-crossing estimate.'
            }),
            jsx(Command, {
              label: 'Off-peak advisor',
              command: 'burnclock offpeak',
              note: 'Current DeepSeek Flash clock and the next large window.'
            }),
            jsx(Command, {
              label: 'Budget',
              command: 'burnclock budget show',
              note: 'Monthly budget bars and spend estimates.'
            }),
            jsx(Command, {
              label: 'Badge cache',
              command: 'burnclock badge --refresh',
              note: 'Updates the desktop chip and this page.'
            })
          ]
        })
      }),

      jsx(Card, {
        title: 'What it covers',
        children: jsxs('div', {
          className: 'grid gap-2.5 sm:grid-cols-2',
          children: [
            jsx(Feature, {
              name: 'Balance + runway',
              children: 'Provider balance, status, recent burn and days left.'
            }),
            jsx(Feature, {
              name: 'Off-peak advisor',
              children: 'DeepSeek Flash peak windows, next cheap block and 2× delta.'
            }),
            jsx(Feature, {
              name: 'Forecast',
              children: 'A range, not a promise; bursty usage widens it.'
            }),
            jsx(Feature, {
              name: 'Budget',
              children: 'Monthly budget and estimated spend from local logs.'
            }),
            jsx(Feature, {
              name: 'Badge',
              children: 'One-line balance for the status bar, shell prompt or tmux.'
            }),
            jsx(Feature, {
              name: 'Free + MIT',
              children: 'No account, no paid tier, no provider writes.'
            })
          ]
        })
      }),

      jsx('p', {
        className: 'px-1 text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Burnclock is free and open source. Figures are local estimates, not billing truth. The off-peak clock follows DeepSeek’s official UTC windows and the bundled Chinese holiday calendar.'
      })
    ]
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

    ctx.register({
      id: 'burnclock-page',
      area: 'routes',
      data: { path: ROUTE },
      render: () => jsx(BurnclockPage, {})
    })

    ctx.register({
      id: 'burnclock-nav',
      area: 'sidebar.nav',
      order: 61,
      data: { path: ROUTE, label: 'Burnclock', codicon: 'watch' }
    })

    ctx.register({
      id: 'burnclock-open',
      area: 'palette',
      data: {
        id: 'burnclock.open',
        label: 'Burnclock: Open dashboard',
        keywords: ['burnclock', 'balance', 'runway', 'tokens', 'credits', 'offpeak', 'off-peak', 'deepseek'],
        run: () => host.navigate(ROUTE)
      }
    })
  }
}
