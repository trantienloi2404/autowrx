// Copyright (c) 2025 Eclipse Foundation.
//
// This program and the accompanying materials are made available under the
// terms of the MIT License which is available at
// https://opensource.org/licenses/MIT.
//
// SPDX-License-Identifier: MIT

/**
 * Sidebar runtime panel: Coder workspace only (no hardware kit / DaRuntimeConnector).
 * Streams run output over WebSocket and merges NDJSON into workspaceRuntimeStore.
 */

import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/atoms/button'
import { TbPlayerPlayFilled } from 'react-icons/tb'
import { FaAnglesLeft, FaAnglesRight } from 'react-icons/fa6'
import { MdStop } from 'react-icons/md'
import { cn } from '@/lib/utils'
import useModelStore from '@/stores/modelStore'
import useWorkspaceRuntimeStore from '@/stores/workspaceRuntimeStore'
import { Prototype } from '@/types/model.type'
import { shallow } from 'zustand/shallow'
import { addLog } from '@/services/log.service'
import useSelfProfileQuery from '@/hooks/useSelfProfile'
import useCurrentModel from '@/hooks/useCurrentModel'
import usePermissionHook from '@/hooks/usePermissionHook'
import { PERMISSIONS } from '@/data/permission'
import DaWorkspaceApisWatch from './DaWorkspaceApisWatch'
import WorkspacePrototypeVarsWatch from './WorkspacePrototypeVarsWatch'
import { countCodeExecution } from '@/services/prototype.service'
import { useSystemUI } from '@/hooks/useSystemUI'
import { useParams } from 'react-router-dom'
import { triggerWorkspaceRun } from '@/services/coder.service'
import useAuthStore from '@/stores/authStore'
import config from '@/configs/config'

type WorkspaceRunUiStatus =
  | 'connecting'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'exited'
  | 'error'

const AlwaysScrollToBottom = () => {
  const elementRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (elementRef?.current) {
      elementRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  })

  return <div ref={elementRef} />
}

/** Merge NDJSON lines (one JSON object per line) into apisValue for dashboard widgets. */
function patchApisFromNdjsonContent(
  content: string,
  setActiveApis: (v: Record<string, unknown>) => void,
) {
  if (!content?.trim()) return
  const lines = content.split(/\r?\n/)
  let patch: Record<string, unknown> = {}
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        patch = { ...patch, ...(o as Record<string, unknown>) }
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (Object.keys(patch).length === 0) return
  const prev =
    (useWorkspaceRuntimeStore.getState().apisValue as
      | Record<string, unknown>
      | undefined) ||
    {}
  setActiveApis({ ...prev, ...patch })
}

const DaWorkspaceRuntimeControl: FC = () => {
  const { prototype_id: routePrototypeId } = useParams<{
    prototype_id?: string
  }>()
  const { data: currentUser } = useSelfProfileQuery()
  const [prototype] = useModelStore(
    (state) => [state.prototype as Prototype],
    shallow,
  )
  const { data: model } = useCurrentModel()
  const [isAuthorized] = usePermissionHook([PERMISSIONS.READ_MODEL, model?.id])
  const { showPrototypeDashboardFullScreen } = useSystemUI()
  const accessToken = useAuthStore((state) => state.access?.token)

  const [setActiveApis, setTraceVars, setAppLog] = useWorkspaceRuntimeStore(
    (state) => [state.setActiveApis, state.setTraceVars, state.setAppLog],
  )

  const [isExpand, setIsExpand] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('output')
  const [vscodeRunOutput, setVscodeRunOutput] = useState('')
  const [stdinLine, setStdinLine] = useState('')
  const [runStatus, setRunStatus] = useState<WorkspaceRunUiStatus>('connecting')
  const [wsReady, setWsReady] = useState(false)
  const [runnerReady, setRunnerReady] = useState(false)
  const [runBlockReason, setRunBlockReason] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const shouldReconnectRef = useRef(false)

  const prototypeIdForCoder = prototype?.id ?? routePrototypeId ?? ''

  const handleClearLog = () => {
    setVscodeRunOutput('')
  }

  /** Run inside Coder workspace (`.autowrx_run` → VS Code extension). */
  const handleCoderWorkspaceRun = () => {
    const id = prototype?.id ?? routePrototypeId
    if (!id) return
    if (!wsReady) {
      setRunStatus('error')
      setRunBlockReason(
        'Runner websocket is not connected yet. Wait until status is ready.',
      )
      return
    }
    if (!runnerReady) {
      setRunStatus('connecting')
      setRunBlockReason(
        'AutoWRX Runner extension is not ready yet. Open VSCode workspace and wait for runner.connected.',
      )
      return
    }
    setActiveTab('output')
    setRunStatus('running')
    setRunBlockReason('')
    setVscodeRunOutput('')
    setAppLog('')
    void triggerWorkspaceRun(id).catch((error) => {
      console.error('[DaWorkspaceRuntimeControl] Coder trigger-run failed:', error)
      setRunStatus('error')
      setRunBlockReason(error?.message || 'Failed to trigger workspace run.')
    })

    notifyWidgetIframes({ action: 'run-app' })

    const userId = currentUser?.id || 'Anonymous'
    if (prototype) {
      addLog({
        name: `User ${userId} run prototype`,
        description: `User ${userId} run prototype ${prototype?.name || 'Unknown'} with id ${prototype?.id || 'Unknown'}`,
        type: 'run-prototype',
        create_by: userId,
      })
      countCodeExecution(prototype.id)
    }
  }

  const notifyWidgetIframes = (data: unknown) => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach((iframe) => {
      iframe.contentWindow?.postMessage(JSON.stringify(data), '*')
    })
  }

  const toWsBase = (baseUrl: string) => {
    if (baseUrl.startsWith('https://')) return baseUrl.replace('https://', 'wss://')
    if (baseUrl.startsWith('http://')) return baseUrl.replace('http://', 'ws://')
    return `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}`
  }

  /** Stream workspace run output via backend WS broker; merge NDJSON into store for widgets. */
  useEffect(() => {
    if (!prototypeIdForCoder || !isAuthorized || !accessToken) return

    shouldReconnectRef.current = true
    setRunStatus('connecting')
    setWsReady(false)
    setRunnerReady(false)
    setRunBlockReason('Connecting to runner websocket...')

    const wsBase = toWsBase(config.serverBaseUrl)
    const wsUrl = `${wsBase}/${config.serverVersion}/system/coder/workspace/${prototypeIdForCoder}/run-ws?access_token=${encodeURIComponent(accessToken)}`
    const connectWs = () => {
      if (!shouldReconnectRef.current) return
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setWsReady(true)
        setRunStatus('connecting')
        setRunBlockReason('Waiting for AutoWRX Runner extension...')
      }

      ws.onerror = () => {
        setWsReady(false)
      }

      ws.onclose = () => {
        setWsReady(false)
        setRunnerReady(false)
        setRunStatus('connecting')
        setRunBlockReason('Runner websocket disconnected. Reconnecting...')
        if (!shouldReconnectRef.current) return
        if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          connectWs()
        }, 1200)
      }

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data))
          if (!payload || typeof payload !== 'object') return
          if (payload.type === 'runner.connected') {
            setRunnerReady(true)
            setRunStatus('ready')
            setRunBlockReason('')
            return
          }
          if (payload.type === 'runner.disconnected') {
            setRunnerReady(false)
            setRunStatus('connecting')
            setRunBlockReason(
              'AutoWRX Runner extension is offline. Waiting for reconnect...',
            )
            return
          }
          if (payload.type === 'run.started') {
            setRunStatus('running')
            return
          }
          if (payload.type === 'run.output') {
            const text = String(payload.data || '')
            if (!text) return
            setVscodeRunOutput((prev) => prev + text)
            setAppLog((useWorkspaceRuntimeStore.getState().appLog || '') + text)
            patchApisFromNdjsonContent(text, setActiveApis)
            setRunStatus('running')
            if (/[?:]\s*$/.test(text) || /\b(input|enter)\b/i.test(text)) {
              setRunStatus('waiting_input')
            }
            return
          }
          if (payload.type === 'run.error') {
            const message = String(
              payload.message || payload.error || payload.data || 'Runner error',
            )
            const summary = `\n[run.error] ${message}\n`
            setVscodeRunOutput((prev) => prev + summary)
            setAppLog((useWorkspaceRuntimeStore.getState().appLog || '') + summary)
            setRunStatus('error')
            setRunBlockReason(message)
            return
          }
          if (payload.type === 'run.waiting_input') {
            setRunStatus('waiting_input')
            return
          }
          if (payload.type === 'run.exit') {
            const summary = `\n[run.exit] code=${payload.code} signal=${payload.signal || 'none'}\n`
            setVscodeRunOutput((prev) => prev + summary)
            setAppLog((useWorkspaceRuntimeStore.getState().appLog || '') + summary)
            setRunStatus('exited')
          }
        } catch {
          // ignore malformed messages
        }
      }
    }

    connectWs()

    return () => {
      shouldReconnectRef.current = false
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      try {
        wsRef.current?.close(1000, 'unmount')
      } catch {
        // ignore
      }
      wsRef.current = null
    }
  }, [prototypeIdForCoder, isAuthorized, accessToken, setActiveApis, setAppLog])

  const writeSignalValue = useCallback(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj || typeof obj !== 'object') return
      const prev =
        (useWorkspaceRuntimeStore.getState().apisValue as Record<
          string,
          unknown
        >) || {}
      setActiveApis({ ...prev, ...obj })
    },
    [setActiveApis],
  )

  const writeVarsValue = useCallback(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj || typeof obj !== 'object') return
      const prev =
        (useWorkspaceRuntimeStore.getState().traceVars as Record<
          string,
          unknown
        >) || {}
      setTraceVars({ ...prev, ...obj })
    },
    [setTraceVars],
  )

  const handleMessageListener = (e: MessageEvent) => {
    if (!e.data) return
    try {
      const payload =
        typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      if (payload?.cmd === 'set-api-value' && payload.api !== undefined) {
        writeSignalValue({ [String(payload.api)]: payload.value })
        writeVarsValue({ [String(payload.api)]: payload.value })
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    window.addEventListener('message', handleMessageListener)
    return () => {
      window.removeEventListener('message', handleMessageListener)
    }
  }, [writeSignalValue, writeVarsValue])

  const outputPanelText = useMemo(() => {
    const placeholder =
      'No output yet. Click Run to start the prototype in the workspace.'
    if (!String(vscodeRunOutput ?? '').trim()) return placeholder
    return vscodeRunOutput
  }, [vscodeRunOutput])

  const submitStdinLine = () => {
    const value = stdinLine.trimEnd()
    if (!value) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        type: 'run.stdin',
        data: value,
      }),
    )
    setStdinLine('')
    setRunStatus('running')
  }

  const stopRun = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        type: 'run.stop',
      }),
    )
    setRunStatus('exited')
  }

  const canRun = Boolean(prototypeIdForCoder) && wsReady && runnerReady
  const runDisabledReason = !prototypeIdForCoder
    ? 'Prototype id is missing.'
    : !wsReady
      ? runBlockReason || 'Runner websocket is not ready.'
      : !runnerReady
        ? runBlockReason || 'AutoWRX Runner extension is not ready.'
      : ''

  const canStop = wsReady && (runStatus === 'running' || runStatus === 'waiting_input')

  const statusLabel = useMemo(() => {
    return `status: ${runStatus}`
  }, [runStatus])

  return (
    <div
      data-id="workspace-runtime-control-panel"
      className={cn(
        'bottom-0 right-0 z-10 flex flex-col px-1 py-1',
        showPrototypeDashboardFullScreen
          ? 'fixed top-[58px]'
          : 'absolute top-0',
        isExpand ? 'w-[500px]' : 'w-14',
      )}
      style={{
        backgroundColor: 'hsl(217, 33%, 17%)',
        color: 'hsl(214, 32%, 91%)',
      }}
    >
      <div className={cn('mt-1 grow overflow-y-auto', !isExpand && 'hidden')}>
        {isExpand && (
          <>
            {activeTab === 'output' && (
              <div className="h-full flex flex-col">
                <div
                  data-id="current-log"
                  className="flex-1 overflow-y-auto whitespace-pre-wrap rounded bg-black px-2 py-1 text-xs"
                  style={{
                    backgroundColor: 'hsl(0, 0%, 0%)',
                    color: 'hsl(0, 0%, 100%)',
                  }}
                >
                  {outputPanelText}
                  <AlwaysScrollToBottom />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={stdinLine}
                    placeholder="Send stdin line..."
                    className="w-full rounded border border-slate-500 bg-slate-100 px-2 py-1 text-slate-900 text-sm placeholder:text-slate-500"
                    onChange={(e) => setStdinLine(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitStdinLine()
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={submitStdinLine}
                    disabled={!wsReady || runStatus === 'error'}
                    className="border border-sky-400 bg-sky-600 text-white hover:bg-sky-500"
                  >
                    Send
                  </Button>
                </div>
              </div>
            )}

            {activeTab === 'apis' && (
              <DaWorkspaceApisWatch
                requestWriteSignalValue={(obj: Record<string, unknown>) => {
                  writeSignalValue(obj)
                }}
              />
            )}

            {activeTab === 'vars' && (
              <WorkspacePrototypeVarsWatch
                requestWriteVarValue={(obj: Record<string, unknown>) => {
                  writeVarsValue(obj)
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="mt-auto flex w-full flex-col">
        <div
          className={cn(
            'flex flex-col items-stretch gap-1 px-1 pb-2',
            isExpand && 'flex-row items-center justify-start gap-2',
          )}
        >
          <button
            type="button"
            data-id="btn-run-prototype-sidebar-lower"
            disabled={!canRun}
            onClick={handleCoderWorkspaceRun}
            className="flex items-center justify-center rounded border p-2 font-semibold text-sm"
            title={runDisabledReason}
            style={{
              color: canRun
                ? 'hsl(0, 0%, 100%)'
                : 'hsl(215, 16%, 47%)',
              borderColor: 'hsl(215, 16%, 47%)',
            }}
            onMouseEnter={(e) => {
              if (canRun) {
                e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
            }}
          >
            <TbPlayerPlayFilled className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-id="btn-stop-prototype-sidebar-lower"
            disabled={!canStop}
            onClick={stopRun}
            className="flex items-center justify-center rounded border p-2 font-semibold text-sm"
            style={{
              color: canStop ? 'hsl(0, 0%, 100%)' : 'hsl(215, 16%, 47%)',
              borderColor: 'hsl(0, 84%, 60%)',
              backgroundColor: canStop ? 'hsl(0, 72%, 40%)' : 'transparent',
            }}
            onMouseEnter={(e) => {
              if (canStop) {
                e.currentTarget.style.backgroundColor = 'hsl(0, 72%, 35%)'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = canStop
                ? 'hsl(0, 72%, 40%)'
                : 'transparent'
            }}
            title={canStop ? 'Stop running process' : 'No active run to stop'}
          >
            <MdStop className="h-4 w-4" />
          </button>
          {isExpand && (
            <div className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-100">
              {statusLabel}
              {!canRun && runDisabledReason ? ` - ${runDisabledReason}` : ''}
            </div>
          )}
        </div>

        <div className="flex">
          <Button
            variant="ghost"
            data-id="btn-expand-runtime-control"
            onClick={() => {
              setIsExpand((v) => !v)
            }}
            className="group hover:bg-slate-700"
            size="sm"
          >
            {isExpand ? (
              <FaAnglesRight
                className="w-4 h-4"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(215, 25%, 27%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(0, 0%, 100%)'
                }}
              />
            ) : (
              <FaAnglesLeft
                className="w-4 h-4"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(215, 25%, 27%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(0, 0%, 100%)'
                }}
              />
            )}
          </Button>

          {isExpand && (
            <>
              <div className="grow" />
              <div
                data-id="btn-runtime-control-tab-output"
                className={cn(
                  'text-xs flex cursor-pointer items-center px-4 py-0.5',
                  activeTab === 'output' && 'border-b-2',
                )}
                style={{
                  color: 'hsl(0, 0%, 100%)',
                  borderBottomColor:
                    activeTab === 'output'
                      ? 'hsl(0, 0%, 100%)'
                      : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                }}
                onClick={() => {
                  setActiveTab('output')
                }}
              >
                Terminal
              </div>
              {prototype?.language === 'cpp' && (
                <div
                  data-id="btn-runtime-control-tab-vars"
                  className={cn(
                    'text-xs flex cursor-pointer items-center px-4 py-0.5',
                    activeTab === 'vars' && 'border-b-2',
                  )}
                  style={{
                    color: 'hsl(0, 0%, 100%)',
                    borderBottomColor:
                      activeTab === 'vars'
                        ? 'hsl(0, 0%, 100%)'
                        : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor =
                      'hsl(215, 16%, 47%)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                  onClick={() => {
                    setActiveTab('vars')
                  }}
                >
                  Vars Watch
                </div>
              )}
              <div
                data-id="btn-runtime-control-tab-apis"
                className={cn(
                  'text-xs flex cursor-pointer items-center px-4 py-0.5',
                  activeTab === 'apis' && 'border-b-2',
                )}
                style={{
                  color: 'hsl(0, 0%, 100%)',
                  borderBottomColor:
                    activeTab === 'apis'
                      ? 'hsl(0, 0%, 100%)'
                      : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                }}
                onClick={() => {
                  setActiveTab('apis')
                }}
              >
                Signals Watch
              </div>
              <Button
                size="sm"
                variant="ghost"
                data-id="btn-clear-log"
                className="text-xs px-2"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onClick={handleClearLog}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default DaWorkspaceRuntimeControl
