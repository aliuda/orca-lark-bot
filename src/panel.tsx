// Orca right-sidebar components panel for Lark Bot Bridge.
// No hooks, no DOM, no external network: all state lives in atoms and talks to the
// plugin worker via plugin.request / plugin.on.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { BridgeSnapshot, ConnectionState, RequestSummary } from './types'

const snapshotAtom = atom<BridgeSnapshot | null>(null)
const loadingAtom = atom<boolean>(true)
const busyActionAtom = atom<string | null>(null)
const noticeAtom = atom<{ tone: 'success' | 'danger' | 'warning' | 'neutral'; text: string } | null>(
  null
)
const secretDraftAtom = atom('secretDraft', '')
const appIdDraftAtom = atom('appIdDraft', '')
const webhookDraftAtom = atom('webhookDraft', '')
const targetBotDraftAtom = atom('targetBotDraft', '')

function syncDraftsFromSnapshot(snap: BridgeSnapshot): void {
  if (!read(appIdDraftAtom) && snap.appId) {
    set(appIdDraftAtom, snap.appId)
  }
  if (!read(targetBotDraftAtom) && snap.targetBot) {
    set(targetBotDraftAtom, snap.targetBot)
  }
}

async function refreshSnapshot(): Promise<void> {
  try {
    const snap = await plugin.request('bridge.getSnapshot')
    set(snapshotAtom, snap)
    syncDraftsFromSnapshot(snap)
  } catch (err) {
    set(noticeAtom, {
      tone: 'danger',
      text: `加载桥接状态失败：${err instanceof Error ? err.message : String(err)}`
    })
  } finally {
    set(loadingAtom, false)
  }
}

async function runAction(label: string, fn: () => Promise<void>): Promise<void> {
  if (read(busyActionAtom)) return
  set(busyActionAtom, label)
  set(noticeAtom, null)
  try {
    await fn()
  } catch (err) {
    set(noticeAtom, {
      tone: 'danger',
      text: err instanceof Error ? err.message : String(err)
    })
  } finally {
    set(busyActionAtom, null)
  }
}

async function handleSaveSecret(): Promise<void> {
  const secret = read(secretDraftAtom).trim()
  if (!secret) {
    set(noticeAtom, { tone: 'warning', text: '请先输入 Feishu App Secret。' })
    return
  }
  await runAction('saveSecret', async () => {
    await plugin.request('bridge.saveSecret', { appSecret: secret })
    set(secretDraftAtom, '')
    set(noticeAtom, {
      tone: 'success',
      text: 'App Secret 已安全写入 Orca secrets:own，凭证就绪后将自动连接。'
    })
    await refreshSnapshot()
  })
}

async function handleClearSecret(): Promise<void> {
  await runAction('clearSecret', async () => {
    await plugin.request('bridge.clearSecret')
    set(secretDraftAtom, '')
    set(noticeAtom, { tone: 'neutral', text: '已清除 App Secret 并断开长连接。' })
    await refreshSnapshot()
  })
}

async function handleSaveQuickConfig(): Promise<void> {
  await runAction('saveConfig', async () => {
    const patch: { appId?: string; targetBot?: string; webhookUrl?: string } = {}
    const appId = read(appIdDraftAtom).trim()
    const targetBot = read(targetBotDraftAtom).trim()
    const webhookUrl = read(webhookDraftAtom).trim()
    if (appId) patch.appId = appId
    if (targetBot) patch.targetBot = targetBot
    if (webhookUrl) patch.webhookUrl = webhookUrl
    const snap = await plugin.request('bridge.updateSettings', patch)
    set(snapshotAtom, snap)
    if (webhookUrl) set(webhookDraftAtom, '')
    set(noticeAtom, {
      tone: 'success',
      text: '基础配置已保存到插件设置，凭证就绪后将自动连接。'
    })
  })
}

async function handleGeneratePairingCode(): Promise<void> {
  await runAction('generateCode', async () => {
    const res = await plugin.request('bridge.generatePairingCode')
    set(noticeAtom, {
      tone: 'success',
      text: `配对码已生成：${res.code}（10 分钟内有效），请私聊机器人发送 /pair ${res.code}。`
    })
    await refreshSnapshot()
  })
}

async function handleRevokePairing(): Promise<void> {
  await runAction('revokePairing', async () => {
    await plugin.request('bridge.revokePairing')
    set(noticeAtom, { tone: 'warning', text: '已核销当前 Owner 绑定与待配对码。' })
    await refreshSnapshot()
  })
}

async function handleReconnect(): Promise<void> {
  await runAction('reconnect', async () => {
    const res = await plugin.request('bridge.reconnect')
    if (res.ok) {
      set(noticeAtom, { tone: 'success', text: `飞书长连接状态：${res.state}` })
    } else {
      set(noticeAtom, { tone: 'danger', text: res.error ?? '重连失败' })
    }
    await refreshSnapshot()
  })
}

async function handleDisconnect(): Promise<void> {
  await runAction('disconnect', async () => {
    await plugin.request('bridge.disconnect')
    set(noticeAtom, { tone: 'neutral', text: '已主动断开飞书长连接。' })
    await refreshSnapshot()
  })
}

function connectionTone(
  state: ConnectionState
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'neutral'
  }
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Online'
    case 'connecting':
      return 'Connecting'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Offline'
    case 'unconfigured':
      return 'Setup Required'
  }
}

function requestTone(
  req: RequestSummary
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  if (req.outcome === 'completed') return 'success'
  if (req.outcome === 'timeout') return 'warning'
  if (req.outcome === 'failed' || req.status === 'failed') return 'danger'
  if (req.status === 'dispatched') return 'accent'
  return 'neutral'
}

function requestLabel(req: RequestSummary): string {
  if (req.status === 'posted' && req.outcome) {
    return req.outcome === 'completed'
      ? 'Completed'
      : req.outcome === 'timeout'
        ? 'Timeout'
        : 'Failed'
  }
  return req.status
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('bridge.snapshot', (snap) => {
      set(snapshotAtom, snap)
      set(loadingAtom, false)
      syncDraftsFromSnapshot(snap)
    })
  )
  void refreshSnapshot()
}

export default function LarkBotPanel() {
  const loading = read(loadingAtom)
  const snap = read(snapshotAtom)
  const busy = read(busyActionAtom)
  const notice = read(noticeAtom)

  if (loading && !snap) {
    return (
      <Stack gap="md" align="center">
        <Spinner label="Loading Lark Bot Bridge status" />
        <Text muted size="sm">
          正在连接插件 Worker…
        </Text>
      </Stack>
    )
  }

  if (!snap) {
    return (
      <EmptyState
        icon="warning"
        title="无法获取桥接状态"
        description={notice?.text ?? '请稍后重试或重新加载插件。'}
      >
        <Button icon="refresh" onPress={() => void refreshSnapshot()}>
          重试
        </Button>
      </EmptyState>
    )
  }

  const conn = snap.connection
  const owner = snap.ownerPairing
  const pendingCode = owner.pendingCode

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Lark Bot</Heading>
        <Badge tone={connectionTone(conn.state)}>{connectionLabel(conn.state)}</Badge>
      </Row>

      {notice ? (
        <Callout tone={notice.tone} icon={notice.tone === 'danger' ? 'error' : 'info'}>
          <Text size="sm">{notice.text}</Text>
        </Callout>
      ) : null}

      <Card title="连接与目标 Bot" description="飞书官方长连接（免公网域名）+ /<BotName> 多 Bot 路径路由">
        <Stack gap="sm">
          <Row justify="between" align="center">
            <Text size="sm" muted>
              默认 Orca Bot
            </Text>
            <Badge tone="accent">{snap.targetBot}</Badge>
          </Row>
          <Row justify="between" align="center">
            <Text size="sm" muted>
              Webhook 通道
            </Text>
            <Badge tone={snap.webhookConfigured ? 'success' : 'warning'}>
              {snap.webhookConfigured ? 'Configured' : 'Not Set'}
            </Badge>
          </Row>
          <Row justify="between" align="center" wrap>
            <Text size="sm" muted>
              已配置路由 ({snap.routes.length})
            </Text>
            <Row gap="xs" wrap>
              {snap.routes.map((route) => (
                <Badge key={route.name} tone={route.webhookConfigured ? 'success' : 'warning'}>
                  {`/${route.name}`}
                </Badge>
              ))}
            </Row>
          </Row>
          <Text size="xs" muted>
            白名单群请使用 <Code>{`@机器人 /${snap.targetBot} <需求>`}</Code>；私聊默认直通，也可通过{' '}
            <Code>{'/<BotName> <需求>'}</Code> 路由到已配置的额外 Bot。
          </Text>
          <Row justify="between" align="center">
            <Text size="sm" muted>
              传输模式 / 回调服务
            </Text>
            <Text size="xs" muted>
              {conn.transportKind} · {conn.callbackUrl ? 'Loopback Ready' : 'Idle'}
            </Text>
          </Row>
          {conn.lastEventAt ? (
            <Row justify="between" align="center">
              <Text size="sm" muted>
                最近入站事件
              </Text>
              <RelativeTime at={conn.lastEventAt} muted />
            </Row>
          ) : null}
          {conn.error ? (
            <Callout tone="danger" icon="error" title="连接异常">
              <Text size="xs">{conn.error}</Text>
            </Callout>
          ) : null}
          <Row gap="xs">
            <Button
              size="sm"
              icon="refresh"
              disabled={busy !== null}
              onPress={() => void handleReconnect()}
            >
              Reconnect
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon="stop"
              disabled={busy !== null || conn.state === 'offline' || conn.state === 'unconfigured'}
              onPress={() => void handleDisconnect()}
            >
              Disconnect
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card title="Owner 认主配对" description="DM 6 位随机配对码认主，未配对前不会唤醒本机 Bot">
        <Stack gap="sm">
          <Row justify="between" align="center">
            <Text size="sm" muted>
              Owner 绑定状态
            </Text>
            <Badge tone={owner.ownerOpenId ? 'success' : 'warning'}>
              {owner.ownerOpenId ? 'Paired' : 'Unpaired'}
            </Badge>
          </Row>
          {owner.ownerOpenId ? (
            <Stack gap="xs">
              <Text size="xs" muted>
                Owner open_id: <Code>{owner.ownerOpenId}</Code>
              </Text>
              {owner.pairedAt ? (
                <Text size="xs" muted>
                  配对时间：<RelativeTime at={owner.pairedAt} muted />
                </Text>
              ) : null}
            </Stack>
          ) : null}
          {pendingCode ? (
            <Callout tone="accent" icon="bot" title="当前 6 位配对码">
              <Stack gap="xs">
                <Text size="sm" weight="semibold">
                  <Code>{pendingCode.code}</Code>
                </Text>
                <Text size="xs" muted>
                  私聊机器人发送 <Code>{`/pair ${pendingCode.code}`}</Code>（剩余尝试{' '}
                  {pendingCode.maxAttempts - pendingCode.attempts} 次，过期时间{' '}
                  <RelativeTime at={pendingCode.expiresAt} />）
                </Text>
              </Stack>
            </Callout>
          ) : null}
          <Row gap="xs">
            <Button
              size="sm"
              variant="solid"
              disabled={busy !== null}
              onPress={() => void handleGeneratePairingCode()}
            >
              生成配对码
            </Button>
            <Button
              size="sm"
              variant="outline"
              tone="danger"
              disabled={busy !== null || (!owner.ownerOpenId && !pendingCode)}
              onPress={() => void handleRevokePairing()}
            >
              核销配对
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card title="飞书凭证与基础配置" description="App Secret 加密保存在 Orca secrets:own，不落盘明文">
        <Stack gap="sm">
          <Row justify="between" align="center">
            <Text size="sm" muted>
              App Secret
            </Text>
            <Badge tone={snap.hasAppSecret ? 'success' : 'warning'}>
              {snap.hasAppSecret ? 'Saved in Keyring' : 'Missing'}
            </Badge>
          </Row>
          <Input
            label="Feishu App Secret"
            type="password"
            placeholder="输入自建应用 App Secret（保存后自动清空输入框）"
            value={read(secretDraftAtom)}
            onChange={(val) => set(secretDraftAtom, val)}
            onSubmit={() => void handleSaveSecret()}
          />
          <Row gap="xs">
            <Button
              size="sm"
              disabled={busy !== null}
              onPress={() => void handleSaveSecret()}
            >
              保存 Secret
            </Button>
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              disabled={busy !== null || !snap.hasAppSecret}
              onPress={() => void handleClearSecret()}
            >
              清除 Secret
            </Button>
          </Row>

          <Input
            label="Feishu App ID"
            placeholder="cli_xxxxxxxxxxxx"
            value={read(appIdDraftAtom)}
            onChange={(val) => set(appIdDraftAtom, val)}
          />
          <Input
            label="Target Orca Bot"
            placeholder="MyBot"
            value={read(targetBotDraftAtom)}
            onChange={(val) => set(targetBotDraftAtom, val)}
          />
          <Input
            label="Orca Bot Webhook URL"
            type="password"
            placeholder={
              snap.webhookConfigured
                ? `已配置（${snap.webhookUrlPreview}），留空保持不变`
                : '粘贴 Bot 自动化卡片 Copy URL'
            }
            value={read(webhookDraftAtom)}
            onChange={(val) => set(webhookDraftAtom, val)}
          />
          <Row gap="xs">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onPress={() => void handleSaveQuickConfig()}
            >
              保存基础配置
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card
        title="最近飞书请求"
        description={`共 ${snap.stats.totalRequests} 条 · 进行中 ${snap.stats.inFlight} · 已去重消息 ${snap.stats.dedupedMessages} 条`}
      >
        {snap.recentRequests.length === 0 ? (
          <EmptyState
            icon="activity"
            title="暂无飞书请求"
            description="完成配对并连上飞书长连接后，来自私聊或白名单群的请求会显示在这里。"
          />
        ) : (
          <List label="Recent Feishu requests">
            {snap.recentRequests.slice(0, 12).map((req) => (
              <ListItem
                key={req.requestId}
                icon={req.chatType === 'p2p' ? 'bot' : 'agent'}
                title={req.promptSummary}
                description={req.errorMessage ?? req.answerPreview ?? req.requestId}
              >
                <Row gap="xs" align="center" justify="between">
                  <Row gap="xs" align="center" wrap>
                    <Badge tone={requestTone(req)}>{requestLabel(req)}</Badge>
                    <Badge tone="accent">{req.targetBot}</Badge>
                    <Badge tone="neutral">{req.chatType === 'p2p' ? 'DM' : 'Group'}</Badge>
                  </Row>
                  <RelativeTime at={req.createdAt} muted />
                </Row>
              </ListItem>
            ))}
          </List>
        )}
      </Card>
    </Stack>
  )
}
