# OpsPilot Sprint 5: Notification Platform & Action Queue

## 📖 Architecture Overview

The **Notification Platform & Action Queue** decouples operational incident decision-making from physical message delivery.

```text
┌────────────────────────┐      enqueueAction()      ┌─────────────────────────┐
│                        ├──────────────────────────►│    notification_actions │
│   Follow-up Engine     │   (Zero messaging code)   │      (Action Queue)     │
└────────────────────────┘                           └────────────┬────────────┘
                                                                  │
                                                        dispatchPendingActions()
                                                                  ▼
                                                     ┌─────────────────────────┐
                                                     │ NotificationDispatcher  │
                                                     └────────────┬────────────┘
                                                                  │
                                            ┌─────────────────────┴─────────────────────┐
                                            ▼                                           ▼
                                ┌───────────────────────┐                   ┌───────────────────────┐
                                │    ConsoleProvider    │                   │   TelegramProvider    │
                                │   (Default logging)   │                   │ (Pluggable Markdown)  │
                                └───────────────────────┘                   └───────────────────────┘
```

---

## ⚙️ Core Components

1. **`ActionQueue` (`src/engine/action-queue/queue.ts`)**:
   - Manages asynchronous enqueueing, status updates, and retrieval of notification actions.
   - Enforces deduplication using `deduplication_key`.

2. **`Deduplicator` (`src/engine/action-queue/deduplicator.ts`)**:
   - Generates deterministic keys (`incidentId:actionType:version`).
   - Prevents duplicate notification enqueues across state evaluations.

3. **`RetryEngine` (`src/engine/action-queue/retry.ts`)**:
   - Exponential backoff policy (30s, 60s, 120s). Max retries default = 3.

4. **`NotificationDispatcher` (`src/notifications/dispatcher.ts`)**:
   - Fetches pending due actions.
   - Sets status `PROCESSING`, builds structured message text, and executes provider sending.
   - Updates status to `SENT` or schedules retries on failure.

5. **Providers (`src/notifications/providers/`)**:
   - `ConsoleProvider`: Default logging provider. Always healthy.
   - `TelegramProvider`: Pluggable Telegram Bot provider. Operates in dry-run/mock mode when tokens are absent.

---

## 🔄 Action Lifecycle & Status Transitions

```text
[NEW ACTION] ──► PENDING ──► PROCESSING ──► SENT (Success)
                   ▲            │
                   │            ▼
                   └── Retry ── FAILED (Max Retries Exceeded)
```

| Status | Description |
|---|---|
| `PENDING` | Action enqueued and waiting for delivery time. |
| `PROCESSING` | Currently being dispatched by NotificationDispatcher. |
| `SENT` | Successfully delivered by provider. |
| `FAILED` | Delivery failed after maximum retry attempts. |
| `CANCELLED` | Manually or programmatically cancelled before dispatch. |
| `EXPIRED` | Scheduled time exceeded expiration threshold. |

---

## 🔌 Adding Future Providers (Slack, Zalo, Email)

Implement the `NotificationProvider` interface in `src/notifications/providers/`:

```typescript
import { NotificationProvider, SendResult, ProviderHealth } from "./provider";

export class CustomProvider implements NotificationProvider {
  name(): string { return "custom"; }
  async send(action: NotificationActionRow, formattedMessage?: string): Promise<SendResult> { ... }
  async health(): Promise<ProviderHealth> { ... }
}
```

Register it in `NotificationDispatcher`:
```typescript
dispatcher.registerProvider(new CustomProvider());
```
