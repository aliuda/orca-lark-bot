// Scenarios rendered by `orca plugin check` (each runs on a fresh host with the real worker).
// `autoConnect: false` keeps offline checks deterministic without dialing open.feishu.cn.
import { defineCheck } from 'orca/testing'
import { STORAGE_KEYS } from './store'
import { SECRET_APP_SECRET } from './worker'

const NOW = Date.now()

export default defineCheck({
  unconfigured: {
    settings: {
      autoConnect: false,
      appId: '',
      targetBot: 'MyBot',
      webhookUrl: ''
    }
  },
  paired_idle: {
    settings: {
      autoConnect: false,
      appId: 'cli_example_app_id',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: '',
      allowedChatIds: 'oc_group_alpha'
    },
    secrets: {
      [SECRET_APP_SECRET]: 'example_placeholder_secret'
    },
    storage: {
      [STORAGE_KEYS.owner]: {
        ownerOpenId: 'ou_example_owner',
        ownerDmChatId: 'oc_example_dm',
        pairedAt: NOW - 600_000
      }
    }
  },
  active_requests: {
    settings: {
      autoConnect: false,
      appId: 'cli_example_app_id',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: '',
      botRoutes: 'Coder=https://hooks.example.test/coder',
      allowedChatIds: 'oc_group_alpha'
    },
    secrets: {
      [SECRET_APP_SECRET]: 'example_placeholder_secret'
    },
    storage: {
      [STORAGE_KEYS.owner]: {
        ownerOpenId: 'ou_example_owner',
        ownerDmChatId: 'oc_example_dm',
        pairedAt: NOW - 3_600_000,
        pendingCode: {
          code: '482913',
          createdAt: NOW - 60_000,
          expiresAt: NOW + 540_000,
          attempts: 0,
          maxAttempts: 5
        }
      },
      [STORAGE_KEYS.dedupe]: [
        { messageId: 'om_msg_1', seenAt: NOW - 120_000 },
        { messageId: 'om_msg_2', seenAt: NOW - 60_000 }
      ],
      [STORAGE_KEYS.requests]: [
        {
          requestId: 'req_demo_1',
          messageId: 'om_msg_1',
          chatId: 'oc_example_dm',
          chatType: 'p2p',
          conversationKey: 'https://open.feishu.cn|cli_example_app_id|mybot|oc_example_dm|dm:oc_example_dm',
          senderOpenId: 'ou_example_owner',
          senderName: 'Owner',
          rawText: '帮我看下今天的 PR 进展',
          promptText: '帮我看下今天的 PR 进展',
          targetBot: 'MyBot',
          status: 'posted',
          outcome: 'completed',
          progressHistory: [],
          finalAnswer: '已完成检查：当前有 2 个 PR 待合并。',
          createdAt: NOW - 120_000,
          updatedAt: NOW - 95_000,
          deadlineAt: NOW + 180_000
        },
        {
          requestId: 'req_demo_2',
          messageId: 'om_msg_2',
          chatId: 'oc_group_alpha',
          chatType: 'group',
          threadId: 'omt_thread_9',
          conversationKey: 'https://open.feishu.cn|cli_example_app_id|coder|oc_group_alpha|thread:omt_thread_9',
          senderOpenId: 'ou_example_owner',
          senderName: 'Owner',
          rawText: '@MyBot /Coder 跑一遍单测并汇报结果',
          promptText: '跑一遍单测并汇报结果',
          targetBot: 'Coder',
          status: 'dispatched',
          progressHistory: [{ at: NOW - 45_000, stage: 'Testing', text: '正在执行单元测试…' }],
          createdAt: NOW - 60_000,
          updatedAt: NOW - 45_000,
          deadlineAt: NOW + 240_000
        }
      ]
    }
  }
})
