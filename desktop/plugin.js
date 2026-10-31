// Burnclock — status-bar chip plus a workspace dashboard page.
//
// Data path: the chip and page read burnclock's local cache files directly
// (`badge.txt` for the one-line label, `badge.json` for status/runway) via one
// `shell.exec` cat. They never run the CLI themselves. The page also runs only
// the pure-clock `burnclock offpeak --json` command for the DeepSeek window.
//
// Provider keys are entered in the page's API-keys card. The plugin's own
// Python backend saves them to burnclock's keys file (mode 0600) and runs the
// CLI refresh with only those keys; the desktop half never sees a key and there
// is no path from Hermes credentials into the CLI.
//
// Requires: the burnclock CLI (pip install burnclock) to populate the cache.

import {
  Codicon,
  StatusDot,
  Tip,
  cn,
  haptic,
  host,
  useMutation,
  useQuery,
  useQueryClient
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

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
// Refresh is backend-only. The API-keys backend runs the CLI with the
// allowlisted provider values from burnclock's own keys file; it never forwards
// provider variables inherited from the gateway process.
const POLL_MS = 60_000
const KEYS_POLL_MS = 30_000

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
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
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
  refetchInterval: POLL_MS,
  staleTime: POLL_MS / 2,
  retry: 0
}

function keysQuery(api) {
  return {
    queryKey: [ID, 'keys'],
    queryFn: () => api('/keys'),
    refetchInterval: KEYS_POLL_MS,
    staleTime: KEYS_POLL_MS / 2,
    retry: 0
  }
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

function keyTone(provider) {
  if (!provider?.configured) return 'muted'
  const state = provider.status?.state
  if (!state || state === 'OK') return state === 'OK' ? 'good' : 'muted'
  if (state === 'EMPTY') return 'warn'
  return 'bad'
}

function keyStateLabel(provider) {
  if (!provider?.configured) return 'NOT SET'
  return provider.status?.state || 'SAVED'
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

function KeyCard({ api }) {
  const qc = useQueryClient()
  const keysQ = useQuery(keysQuery(api))
  const [providerId, setProviderId] = useState('')
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [notice, setNotice] = useState(null)

  const providers = keysQ.data?.providers || []
  const selected = providers.find((provider) => provider.id === providerId) || providers[0]
  const selectedId = selected?.id || ''
  const canSave = Boolean(selectedId && value.trim())

  function showRefresh(refresh) {
    if (!refresh) return ''
    if (refresh.ok) return ' Balance refreshed.'
    return ` Refresh reported: ${refresh.message || 'not ready yet.'}`
  }

  const save = useMutation({
    mutationFn: () =>
      api('/keys', {
        method: 'POST',
        body: { provider: selectedId, key: value.trim(), refresh: true }
      }),
    onSuccess: (result) => {
      setValue('')
      setRevealed(false)
      setNotice({
        tone: result?.refresh?.ok ? 'good' : 'warn',
        text:
          `Saved ${selected?.label || 'provider'} key${result?.masked ? ` (${result.masked})` : ''}.` +
          showRefresh(result?.refresh)
      })
      qc.invalidateQueries({ queryKey: [ID, 'keys'] })
      qc.invalidateQueries({ queryKey: [ID, 'badge'] })
    },
    onError: (error) => {
      setNotice({
        tone: 'bad',
        text: error?.message || 'Could not save the key.'
      })
    }
  })

  const refresh = useMutation({
    mutationFn: () => api('/refresh', { method: 'POST', body: {} }),
    onSuccess: (result) => {
      setNotice({
        tone: result?.ok ? 'good' : 'warn',
        text: result?.message || (result?.ok ? 'Balance refreshed.' : 'Refresh did not complete.')
      })
      qc.invalidateQueries({ queryKey: [ID, 'keys'] })
      qc.invalidateQueries({ queryKey: [ID, 'badge'] })
    },
    onError: (error) => {
      setNotice({ tone: 'bad', text: error?.message || 'Could not refresh the cache.' })
    }
  })

  const noticeClass =
    notice?.tone === 'good'
      ? 'text-(--ui-green)'
      : notice?.tone === 'warn'
        ? 'text-(--ui-yellow)'
        : 'text-(--ui-red)'

  return jsx(Card, {
    title: 'API keys',
    aside: jsx('span', {
      className: 'text-[0.625rem] text-(--ui-text-quaternary)',
      children: 'burnclock-owned'
    }),
    children: jsxs('div', {
      children: [
        keysQ.isLoading
          ? jsx('div', {
              className: 'text-[0.75rem] text-(--ui-text-tertiary)',
              children: 'Checking saved keys…'
            })
          : null,
        keysQ.error
          ? jsx('div', {
              className: 'rounded-md border border-(--ui-red)/35 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-(--ui-red)',
              children:
                'Key setup backend unavailable. In Capabilities → Plugins, rescan or reload Burnclock, then open this page again.'
            })
          : null,
        !keysQ.isLoading && !keysQ.error
          ? jsxs('div', {
              children: [
                jsx('div', {
                  className: 'divide-y divide-(--ui-stroke-secondary)/60',
                  children: providers.map((provider) =>
                    jsxs(
                      'div',
                      {
                        className: 'flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0',
                        children: [
                          jsx(StatusDot, { tone: keyTone(provider) }),
                          jsxs('div', {
                            className: 'min-w-0 flex-1',
                            children: [
                              jsx('div', {
                                className: 'text-[0.75rem] text-foreground',
                                children: provider.label
                              }),
                              jsx('div', {
                                className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)',
                                children: provider.variable
                              })
                            ]
                          }),
                          jsx('code', {
                            className: 'rounded border border-(--ui-stroke-secondary)/60 px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
                            children: provider.configured ? provider.masked : 'not set'
                          }),
                          jsx('span', {
                            className: cn(
                              'rounded-full border px-1.5 py-0.5 text-[0.625rem]',
                              keyTone(provider) === 'good'
                                ? 'border-(--ui-green)/40 text-(--ui-green)'
                                : keyTone(provider) === 'warn'
                                  ? 'border-(--ui-yellow)/40 text-(--ui-yellow)'
                                  : keyTone(provider) === 'bad'
                                    ? 'border-(--ui-red)/40 text-(--ui-red)'
                                    : 'border-(--ui-stroke-secondary) text-(--ui-text-tertiary)'
                            ),
                            children: keyStateLabel(provider)
                          })
                        ]
                      },
                      provider.id
                    )
                  )
                }),
                jsxs('form', {
                  className: 'mt-3 space-y-2',
                  onSubmit: (event) => {
                    event.preventDefault()
                    if (canSave && !save.isPending) save.mutate()
                  },
                  children: [
                    jsxs('div', {
                      className: 'flex flex-wrap items-center gap-2',
                      children: [
                        jsx('select', {
                          value: selectedId,
                          onChange: (event) => {
                            setProviderId(event.target.value)
                            setNotice(null)
                          },
                          className:
                            'h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-[0.75rem] text-foreground',
                          'aria-label': 'Provider',
                          children: providers.map((provider) =>
                            jsx('option', { value: provider.id, children: provider.label }, provider.id)
                          )
                        }),
                        jsxs('div', {
                          className: 'flex min-w-[12rem] flex-1 items-center gap-1',
                          children: [
                            jsx('input', {
                              type: revealed ? 'text' : 'password',
                              value,
                              onChange: (event) => {
                                setValue(event.target.value)
                                setNotice(null)
                              },
                              placeholder: selected?.placeholder || 'Paste API key',
                              autoComplete: 'off',
                              spellCheck: false,
                              className:
                                'h-8 min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2.5 font-mono text-[0.75rem] text-foreground placeholder:text-(--ui-text-quaternary)',
                              'aria-label': `${selected?.label || 'Provider'} API key`
                            }),
                            jsx('button', {
                              type: 'button',
                              className:
                                'inline-flex h-8 w-8 items-center justify-center rounded-md border border-(--ui-stroke-secondary) text-(--ui-text-tertiary) hover:text-foreground',
                              onClick: () => setRevealed((current) => !current),
                              'aria-label': revealed ? 'Hide API key' : 'Show API key',
                              children: jsx(Codicon, { name: revealed ? 'eye-closed' : 'eye' })
                            })
                          ]
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex flex-wrap items-center gap-2',
                      children: [
                        jsx('button', {
                          type: 'submit',
                          disabled: !canSave || save.isPending,
                          className:
                            'rounded-md border border-(--ui-accent)/40 bg-(--ui-accent)/10 px-2.5 py-1.5 text-[0.75rem] font-medium text-foreground hover:bg-(--ui-accent)/15 disabled:opacity-50',
                          children: save.isPending ? 'Saving…' : 'Save & refresh'
                        }),
                        jsx('button', {
                          type: 'button',
                          disabled: refresh.isPending || !keysQ.data?.can_refresh,
                          className:
                            'rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1.5 text-[0.75rem] text-(--ui-text-secondary) hover:text-foreground disabled:opacity-50',
                          onClick: () => refresh.mutate(),
                          children: refresh.isPending ? 'Refreshing…' : 'Refresh cache'
                        }),
                        selected?.console_url
                          ? jsx('a', {
                              href: selected.console_url,
                              target: '_blank',
                              rel: 'noreferrer',
                              className:
                                'inline-flex items-center gap-1 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-foreground',
                              children: [
                                jsx(Codicon, { key: 'link', name: 'link-external' }),
                                jsx('span', { key: 'label', children: 'Get a key' })
                              ]
                            })
                          : null
                      ]
                    }),
                    notice
                      ? jsx('div', {
                          className: `text-[0.6875rem] leading-relaxed ${noticeClass}`,
                          role: 'status',
                          children: notice.text
                        })
                      : null
                  ]
                }),
                jsxs('div', {
                  className: 'mt-3 text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
                  children: [
                    'Keys are stored locally in burnclock’s own file',
                    keysQ.data?.keys_file
                      ? jsx('code', {
                          className: 'mx-1 break-all rounded border border-(--ui-stroke-secondary)/60 px-1 py-0.5 text-[0.625rem]',
                          children: keysQ.data.keys_file
                        })
                      : null,
                    keysQ.data?.keys_file_mode
                      ? `(mode ${keysQ.data.keys_file_mode}).`
                      : 'and created with mode 0600 on first save.',
                    ' The dashboard backend returns only the last four characters and sends a new key only to burnclock during refresh.'
                  ]
                })
              ]
            })
          : null
      ]
    })
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

function BurnclockPage({ api }) {
  const badgeQ = useQuery(badgeQuery())
  const offQ = useQuery(offpeakQuery)

  const badge = badgeQ.data
  const p = badge?.provider
  const off = offQ.data
  const runway = runtimeRunway(p)
  const amount = p?.balance?.amount
  const limit = p?.budget?.limit
  const spent = p?.budget?.spent_est
  const overBudget = typeof spent === 'number' && typeof limit === 'number' && spent > limit
  const updated = updatedLabel(badge?.updated_at)

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

      jsx('div', {
        className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Add or replace a provider key below. Keys are saved on this Mac in burnclock’s own keys file and used only by the backend refresh; the desktop page never stores a key and only re-reads the cache.'
      }),

      jsx(KeyCard, { api }),

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
                      children: 'No cache yet. Add a provider key above and refresh; this page re-reads the cache within a minute.'
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
      render: () => jsx(BurnclockPage, { api: ctx.rest })
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
